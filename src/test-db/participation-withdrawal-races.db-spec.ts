import { JwtService } from '@nestjs/jwt';
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
import { DatabaseService } from '../common/database/database.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import { createDb, createUser, deferred, TEST_JWT_SECRET, testConfig, unique, waitFor } from './harness';

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
        displayName: 'Applicant', telegram: '@ninja', twitter: '@ninja', web3Experience: 'Y1_3',
        activityType: 'DEVELOPER', interestAreas: ['DEVELOPER'], intro: 'Joining the cohort.',
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
  async function expectBlocked(work: Promise<unknown>) {
    let settled = false;
    void work.finally(() => { settled = true; }).catch(() => undefined);
    await waitFor(async () => settled || (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n > 0,
    'the competing operation to wait for the user row');
    expect(settled).toBe(false);
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
});
