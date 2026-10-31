import { JwtService } from '@nestjs/jwt';
import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { BountyActor } from '../bounties/bounty-actor';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { CohortAdminService } from '../cohorts/cohort-admin.service';
import { CohortApplicationsService } from '../cohorts/cohort-applications.service';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred, TEST_JWT_SECRET, testConfig, unique, waitFor } from './harness';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

type Scenario = { name: string; kind: 'COHORT' | 'APPLICATION' | 'SUBMISSION'; agent: boolean; existing: boolean };
const scenarios: Scenario[] = [
  { name: 'cohort apply', kind: 'COHORT', agent: false, existing: false },
  { name: 'cohort reapply', kind: 'COHORT', agent: false, existing: true },
  ...(['APPLICATION', 'SUBMISSION'] as const).flatMap((kind) =>
    [false, true].flatMap((agent) => [false, true].map((existing) => ({
      name: `${agent ? 'agent' : 'user'} ${kind.toLowerCase()} ${existing ? 'existing' : 'new'}`,
      kind, agent, existing,
    })))),
];

describeDb('participation and account withdrawal races', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let withdrawal: AccountWithdrawalService;
  let bounties: BountyAdminService;
  let applications: ApplicationsService;
  let submissions: SubmissionsService;
  let cohortAdmin: CohortAdminService;
  let cohorts: CohortApplicationsService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    audit = new AuditService(db);
    const config = testConfig();
    const auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET }), config, TEST_JWT_SECRET);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    applications = new ApplicationsService(db, audit);
    submissions = new SubmissionsService(db);
    cohortAdmin = new CohortAdminService(db, audit);
    cohorts = new CohortApplicationsService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => {
    await db.query(`UPDATE cohort SET status = 'CLOSED' WHERE status = 'OPEN'`);
    await db.onApplicationShutdown();
  });

  async function fixture(scenario: Scenario) {
    const nickname = unique('racer_');
    const userId = await createUser(db, { nickname });
    let agentId: string | undefined;
    let participate: () => Promise<{ id: string }>;
    let rows: () => Promise<{ id: string; status: string }[]>;
    let revisions: (() => Promise<number>) | undefined;

    if (scenario.kind === 'COHORT') {
      await db.query(`UPDATE cohort SET status = 'CLOSED' WHERE status = 'OPEN'`);
      const { id } = await cohortAdmin.create(adminId, { name: unique('race-') });
      await cohortAdmin.transition(id, 'OPEN', adminId);
      const input = {
        displayName: 'Applicant', telegram: '@ninja', twitter: '@ninja', intro: 'Joining the cohort.',
        answers: [{ questionId: 'web3_experience', choices: ['Y1_3'] }, { questionId: 'interest_areas', choices: ['DEVELOPER'] }],
      };
      participate = async () => cohorts.apply(id, userId, input) as Promise<{ id: string }>;
      rows = async () => (await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM cohort_application WHERE cohort_id = $1 AND user_id = $2`, [id, userId])).rows;
      if (scenario.existing) await cohorts.withdraw((await participate()).id, userId);
    } else {
      if (scenario.agent) {
        agentId = (await db.query<{ id: string }>(
          `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
           VALUES ($1, 'racer', $2, $3, 'ACTIVE', now()) RETURNING id`,
          [userId, unique('pk-'), `0x${unique()}`])).rows[0].id;
      }
      const { id } = await bounties.create(adminId, {
        title: unique('race-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired: scenario.kind === 'APPLICATION', submissionMode: scenario.agent ? 'AGENT' : 'DIRECT',
        maxWinners: 1, submissionDeadline: new Date(Date.now() + 86_400_000).toISOString(),
      });
      await bounties.transition(id, 'OPEN', adminId);
      const actor = agentId ? BountyActor.agent(agentId) : BountyActor.user(userId);
      const submission = { submissionUrl: 'https://example.test/work', description: 'submission' };
      if (scenario.kind === 'APPLICATION') {
        participate = () => agentId ? applications.applyAsAgent(id, agentId, 'apply') : applications.apply(id, userId, 'apply');
        rows = async () => (await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM bounty_application WHERE bounty_id = $1 AND ${actor.applicationColumn} = $2`, [id, actor.id])).rows;
        if (scenario.existing) await applications.withdraw((await participate()).id, userId);
      } else {
        participate = () => agentId ? submissions.submitAsAgent(id, agentId, submission) : submissions.submit(id, userId, submission);
        rows = async () => (await db.query<{ id: string; status: string }>(
          `SELECT id, status FROM bounty_submission WHERE bounty_id = $1 AND ${actor.submissionColumn} = $2`, [id, actor.id])).rows;
        revisions = async () => (await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM submission_revision r JOIN bounty_submission s ON s.id = r.submission_id WHERE s.bounty_id = $1`, [id])).rows[0].n;
        if (scenario.existing) await participate();
      }
    }
    return { userId, nickname, agentId, participate, rows, revisions };
  }

  // Observe an actual PostgreSQL lock wait, or detect an operation that incorrectly finishes without waiting.
  async function expectBlocked(work: Promise<unknown>, sqlFragment?: string) {
    let settled = false;
    let waiting: string[] = [];
    void work.finally(() => { settled = true; }).catch(() => undefined);
    await waitFor(async () => {
      if (settled) return true;
      waiting = (await db.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows.map((row) => row.query);
      return waiting.length > 0;
    },
    'the competing operation to wait for the user row');
    expect(settled).toBe(false);
    if (sqlFragment) expect(waiting).toEqual(expect.arrayContaining([expect.stringContaining(sqlFragment)]));
  }

  it.each(scenarios)('$name: participation first commits, then withdrawal cleans the resulting record', async (scenario) => {
    const f = await fixture(scenario);
    const checked = deferred();
    const release = deferred();
    const original = BountyActor.prototype.assertOnboarded;
    const spy = jest.spyOn(BountyActor.prototype, 'assertOnboarded').mockImplementation(async function (this: BountyActor, tx) {
      await original.call(this, tx); // Execute the real SQL, then pause while its transaction is still open.
      checked.resolve();
      await release.promise;
    });
    const participating = f.participate();
    let withdrawing: Promise<unknown> | undefined;
    try {
      await Promise.race([checked.promise, participating.then(() => { throw new Error('participation passed the pause'); })]);
      withdrawing = withdrawal.withdraw(f.userId, f.nickname);
      await expectBlocked(withdrawing);
      release.resolve();
      const result = await participating;
      await expect(withdrawing).resolves.toEqual({ ok: true });
      expect(await f.rows()).toEqual([{ id: result.id, status: 'WITHDRAWN' }]);
      if (f.revisions) expect(await f.revisions()).toBe(scenario.existing ? 2 : 1);
    } finally {
      release.resolve();
      await Promise.allSettled([participating, ...(withdrawing ? [withdrawing] : [])]);
      spy.mockRestore();
    }
  });

  it.each(scenarios)('$name: withdrawal first commits, then participation refuses without inserting or reopening', async (scenario) => {
    const f = await fixture(scenario);
    const before = await f.rows();
    const locked = deferred();
    const release = deferred();
    const original = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (...args) => {
      await original(...args); // Pause the real withdrawal after its writes, before its COMMIT.
      if (args[1] === 'USER_WITHDRAWN') {
        locked.resolve();
        await release.promise;
      }
    });
    const withdrawing = withdrawal.withdraw(f.userId, f.nickname);
    let participating: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, withdrawing.then(() => { throw new Error('withdrawal passed the pause'); })]);
      participating = f.participate();
      await expectBlocked(participating);
      release.resolve();
      await withdrawing;
      await expect(participating).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
      expect(await f.rows()).toEqual(before.map((row) => ({ ...row, status: 'WITHDRAWN' })));
      if (f.revisions) expect(await f.revisions()).toBe(scenario.existing ? 1 : 0);
      if (f.agentId) expect((await db.query(`SELECT status FROM agent WHERE id = $1`, [f.agentId])).rows[0].status).toBe('REVOKED');
    } finally {
      release.resolve();
      await Promise.allSettled([withdrawing, ...(participating ? [participating] : [])]);
      spy.mockRestore();
    }
  });

  it.each(['SUSPENDED', 'WITHDRAWN'])('rejects %s users and agent owners even when deleted_at is still null', async (status) => {
    for (const agent of [false, true]) {
      const f = await fixture({ name: 'inactive', kind: 'APPLICATION', agent, existing: false });
      await db.query(`UPDATE "user" SET status = $2 WHERE id = $1`, [f.userId, status]);
      await expect(f.participate()).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
      expect(await f.rows()).toEqual([]);
    }
  });

  it('agent re-registration locks the owner before occupied agent rows, avoiding a deadlock with withdrawal', async () => {
    const nickname = unique('register_');
    const owner = await createUser(db, { nickname });
    const agents = new AgentsService(db, audit);
    const signer = Wallet.createRandom();
    await agents.register(owner, 'pending', undefined, undefined, signer.address);
    const locked = deferred();
    const release = deferred();
    type Retirer = { retireReusableAgents: (tx: QueryRunner, userId: string, key: string | null, address: string) => Promise<void> };
    const internal = agents as unknown as Retirer;
    const original = internal.retireReusableAgents.bind(agents);
    const spy = jest.spyOn(internal, 'retireReusableAgents').mockImplementation(async (...args) => {
      await original(...args); // Real FOR UPDATE on the existing PENDING agent, before the duplicate INSERT.
      locked.resolve();
      await release.promise;
    });
    const registering = agents.register(owner, 'updated', undefined, undefined, signer.address);
    void registering.catch(() => undefined);
    let withdrawing: Promise<unknown> | undefined;
    try {
      await Promise.race([locked.promise, registering.then(() => { throw new Error('registration passed the pause'); })]);
      withdrawing = withdrawal.withdraw(owner, nickname);
      await expectBlocked(withdrawing, 'SELECT nickname FROM "user"'); // Not blocked on agent rows after already locking the owner.
      release.resolve();
      const [registration] = await Promise.allSettled([registering, withdrawing]);
      // A duplicate INSERT rolls back the first transaction. Withdrawal may win the race with the name-only fallback;
      // either the existing pending registration is returned, or the fallback refuses it. Neither side may deadlock.
      if (registration.status === 'rejected') expect(registration.reason).toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      await expect(withdrawing).resolves.toEqual({ ok: true });
      expect((await db.query(`SELECT status FROM agent WHERE owner_user_id = $1`, [owner])).rows).toEqual([{ status: 'REVOKED' }]);
    } finally {
      release.resolve();
      await Promise.allSettled([registering, ...(withdrawing ? [withdrawing] : [])]);
      spy.mockRestore();
    }
  });
});
