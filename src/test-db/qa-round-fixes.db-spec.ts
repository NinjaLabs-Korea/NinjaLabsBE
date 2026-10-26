import { Wallet } from 'ethers';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { UsersService } from '../users/users.service';
import { DatabaseService } from '../common/database/database.service';
import { HighlightsService } from '../highlights/highlights.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';

// sdk-ts is ESM-only: the e2e stub gives the real inj1 <-> 0x helpers (register compares the agent wallet with the owner's)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

/** QA 라운드에서 나온 규칙들을 실 Postgres 행으로 고정한다: 취소 시 지원 정리, 온보딩 게이트, 공개 builders 정의 */
describeDb('QA round fixes on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let adminId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(testConfig()));
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  async function openBounty(applicationRequired: boolean) {
    const { id } = await bounties.create(adminId, {
      title: unique('qa-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired, submissionMode: 'DIRECT', maxWinners: 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    await bounties.transition(id, 'OPEN', adminId);
    return id;
  }

  it('cancelling a bounty rejects its PENDING applications (without a reviewer note), keeps APPROVED/WITHDRAWN ones, and records the reviewer', async () => {
    const bountyId = await openBounty(true);
    const [pendingUser, approvedUser, withdrawnUser] = [await createUser(db), await createUser(db), await createUser(db)];
    const pending = await applications.apply(bountyId, pendingUser, 'p');
    const approved = await applications.apply(bountyId, approvedUser, 'a');
    await applicationReview.review(approved.id, 'APPROVED', undefined, adminId);
    const withdrawn = await applications.apply(bountyId, withdrawnUser, 'w');
    await applications.withdraw(withdrawn.id, withdrawnUser);
    // a pending application on ANOTHER bounty is untouched
    const otherBounty = await openBounty(true);
    const other = await applications.apply(otherBounty, pendingUser, 'o');
    // an approved applicant who has not submitted does not block cancelling (only owed winners do)
    await bounties.transition(bountyId, 'CANCELLED', adminId);

    const rows = await db.query<{ id: string; status: string; reviewed_by: string | null; review_note: string | null; reviewed_at: Date | null }>(
      `SELECT id, status, reviewed_by, review_note, reviewed_at FROM bounty_application WHERE id = ANY($1::uuid[])`,
      [[pending.id, approved.id, withdrawn.id, other.id]]);
    const byId = Object.fromEntries(rows.rows.map((row) => [row.id, row]));
    expect(byId[pending.id]).toMatchObject({ status: 'REJECTED', reviewed_by: adminId, review_note: null }); // a system transition: no English reviewer note
    expect(byId[pending.id].reviewed_at).toBeInstanceOf(Date);
    expect(byId[approved.id].status).toBe('APPROVED');
    expect(byId[withdrawn.id].status).toBe('WITHDRAWN');
    expect(byId[other.id].status).toBe('PENDING');
    // a rejected application cannot be withdrawn any more (the Withdraw button had nothing to act on) and cannot re-apply
    await expect(applications.withdraw(pending.id, pendingUser)).rejects.toMatchObject({ message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });
  });

  it('a person who has not finished onboarding can neither apply nor submit (409 PROFILE_REQUIRED, no rows); finishing onboarding unlocks both', async () => {
    const applyBounty = await openBounty(true);
    const directBounty = await openBounty(false);
    const newbie = await createUser(db, { onboarded: false });
    await expect(applications.apply(applyBounty, newbie, 'hi')).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    await expect(submissions.submit(directBounty, newbie, { submissionUrl: 'https://example.com/x', description: 'd' }))
      .rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    const rows = await db.query(
      `SELECT (SELECT count(*) FROM bounty_application WHERE applicant_user_id = $1) + (SELECT count(*) FROM bounty_submission WHERE submitter_user_id = $1) AS n`, [newbie]);
    expect(Number(rows.rows[0].n)).toBe(0);

    await db.query(`UPDATE "user" SET onboarding_step = 4, onboarding_completed_at = now() WHERE id = $1`, [newbie]);
    await expect(applications.apply(applyBounty, newbie, 'hi')).resolves.toMatchObject({ status: 'PENDING' });
    await expect(submissions.submit(directBounty, newbie, { submissionUrl: 'https://example.com/x', description: 'd' }))
      .resolves.toMatchObject({ revisionNo: 1 });
  });

  it('hall-of-fame builders counts an approved submitter only once the bounty is COMPLETED or a PAID payout exists', async () => {
    const builders = async () => (await new HighlightsService(db).stats()).builders;
    const start = await builders();
    const user = await createUser(db);
    const wallet = await createPrimaryWallet(db, user);
    const insertBounty = async (status: string) => (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, status)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', $3) RETURNING id`, [adminId, unique('hof-'), status])).rows[0].id;
    const approve = async (bountyId: string, submitter: string) => (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
       VALUES ($1, $2, 'https://example.test', 'd', 'APPROVED') RETURNING id`, [bountyId, submitter])).rows[0].id;

    // approved but nothing paid, bounty still running -> not "rewarded"
    const running = await insertBounty('IN_REVIEW');
    const runningSubmission = await approve(running, user);
    expect(await builders()).toBe(start);
    // approved on a CANCELLED bounty with no payout -> still not rewarded
    await approve(await insertBounty('CANCELLED'), user);
    expect(await builders()).toBe(start);

    // a PAID payout makes the same person a rewarded builder (counted once, however many bounties)
    const reward = (await db.query<{ id: string }>(
      `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address)
       VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 'inj1custody') RETURNING id`, [running])).rows[0].id;
    await db.query(
      `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, payout_tx_hash)
       VALUES ($1, $2, $3, 1000, 'PAID', $4, $5, $6)`, [reward, runningSubmission, wallet.id, unique('idem-'), adminId, fakeTxHash()]);
    expect(await builders()).toBe(start + 1);

    // an approved submitter on a COMPLETED bounty counts without any payout row
    const finisher = await createUser(db);
    await approve(await insertBounty('COMPLETED'), finisher);
    expect(await builders()).toBe(start + 2);
  });

  it('an agent cannot be registered on the owner\'s own connected wallet (0x or inj1 form), but a disconnected wallet and a dedicated wallet are fine; the rejected row is not left behind', async () => {
    const agents = new AgentsService(db, new AuditService(db));
    const owner = await createUser(db);
    const ownerSigner = Wallet.createRandom();
    const { getInjectiveAddress } = jest.requireActual('../test-e2e/support/injective-sdk.stub') as { getInjectiveAddress: (address: string) => string };
    const stored = getInjectiveAddress(ownerSigner.address);
    expect(stored.startsWith('inj1')).toBe(true);
    const wallet = await db.query<{ id: string }>(
      `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`, [owner, stored]);

    await expect(agents.register(owner, 'mine', undefined, undefined, ownerSigner.address)).rejects.toMatchObject({ status: 400, message: 'AGENT_WALLET_IS_OWNER_WALLET' });
    expect((await db.query(`SELECT 1 FROM agent WHERE owner_user_id = $1`, [owner])).rowCount).toBe(0);

    // someone else may use that address for their agent (the rule is about the owner's own wallet)
    const other = await createUser(db);
    await expect(agents.register(other, 'theirs', undefined, undefined, ownerSigner.address)).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });

    // a dedicated wallet works; so does the old wallet after the owner disconnected it
    await expect(agents.register(owner, 'dedicated', undefined, undefined, Wallet.createRandom().address)).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
    await db.query(`UPDATE wallet SET disconnected_at = now() WHERE id = $1`, [wallet.rows[0].id]);
    const freed = Wallet.createRandom();
    await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at, disconnected_at) VALUES ($1, 'INJECTIVE', $2, false, now(), now())`, [owner, getInjectiveAddress(freed.address)]);
    await expect(agents.register(owner, 'freed', undefined, undefined, freed.address)).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
  });

  it('an agent follows its owner onboarding: an unfinished owner cannot register, and a legacy agent of one cannot apply or submit (409 PROFILE_REQUIRED, no rows)', async () => {
    const agents = new AgentsService(db, new AuditService(db));
    const newbie = await createUser(db, { onboarded: false });
    await expect(agents.register(newbie, 'bot', undefined, undefined, Wallet.createRandom().address)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect((await db.query(`SELECT 1 FROM agent WHERE owner_user_id = $1`, [newbie])).rowCount).toBe(0);

    // an agent that exists already (registered before the gate) is blocked at apply / submit through its owner
    const agentId = (await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at) VALUES ($1, 'legacy', $2, 'ACTIVE', now()) RETURNING id`,
      [newbie, Wallet.createRandom().address])).rows[0].id;
    const agentBounty = async (applicationRequired: boolean) => {
      const { id } = await bounties.create(adminId, {
        title: unique('qa-agent-'), sponsorName: 'S', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired, submissionMode: 'AGENT', maxWinners: 1,
        submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
      await bounties.transition(id, 'OPEN', adminId);
      return id;
    };
    const applyBounty = await agentBounty(true);
    const directBounty = await agentBounty(false);
    await expect(applications.applyAsAgent(applyBounty, agentId, 'hi')).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    await expect(submissions.submitAsAgent(directBounty, agentId, { submissionUrl: 'https://example.com/z', description: 'd' }))
      .rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect((await db.query(`SELECT 1 FROM bounty_application WHERE agent_id = $1 UNION ALL SELECT 1 FROM bounty_submission WHERE agent_id = $1`, [agentId])).rowCount).toBe(0);

    await db.query(`UPDATE "user" SET onboarding_step = 4, onboarding_completed_at = now() WHERE id = $1`, [newbie]);
    await expect(applications.applyAsAgent(applyBounty, agentId, 'hi')).resolves.toMatchObject({ status: 'PENDING' });
    await expect(submissions.submitAsAgent(directBounty, agentId, { submissionUrl: 'https://example.com/z', description: 'd' })).resolves.toMatchObject({ status: 'SUBMITTED' });
  });

  it('a public profile exists only for users who finished onboarding (404 USER_NOT_FOUND otherwise)', async () => {
    const users = new UsersService(db);
    const unfinished = await createUser(db, { onboarded: false });
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [unfinished])).rows[0].nickname;
    await expect(users.publicProfile(nickname)).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    await db.query(`UPDATE "user" SET onboarding_step = 4, onboarding_completed_at = now() WHERE id = $1`, [unfinished]);
    await expect(users.publicProfile(nickname)).resolves.toMatchObject({ nickname });
  });

  it('a second START_REVIEW on a submission already IN_REVIEW is 400 SUBMISSION_NOT_REVIEWABLE and writes no review or audit row', async () => {
    const review = new SubmissionReviewService(db, new AuditService(db));
    const bountyId = await openBounty(false);
    const submitter = await createUser(db);
    const { id: submissionId } = await submissions.submit(bountyId, submitter, { submissionUrl: 'https://example.com/r', description: 'd' });
    await expect(review.review(submissionId, 'START_REVIEW', undefined, adminId)).resolves.toMatchObject({ status: 'IN_REVIEW' });
    await expect(review.review(submissionId, 'START_REVIEW', undefined, adminId)).rejects.toMatchObject({ status: 400, message: 'SUBMISSION_NOT_REVIEWABLE' });
    const counts = await db.query<{ reviews: string; audits: string }>(
      `SELECT (SELECT count(*) FROM submission_review WHERE submission_id = $1) AS reviews,
              (SELECT count(*) FROM audit_log WHERE entity_id = $1 AND action = 'SUBMISSION_START_REVIEW') AS audits`, [submissionId]);
    expect(counts.rows[0]).toEqual({ reviews: '1', audits: '1' });
    // the other decisions still work from IN_REVIEW
    await expect(review.review(submissionId, 'REJECT', 'no', adminId)).resolves.toMatchObject({ status: 'REJECTED' });
  });
});
