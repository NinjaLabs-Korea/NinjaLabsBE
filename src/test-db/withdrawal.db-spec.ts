import { JwtService } from '@nestjs/jwt';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { ApplicationReviewService } from '../bounties/applications/application-review.service';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { UsersService } from '../users/users.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser, fakeTxHash, TEST_JWT_SECRET, testConfig, unique } from './harness';

describeDb('account withdrawal on a real database', () => {
  let db: DatabaseService;
  let auth: AuthService;
  let withdrawal: AccountWithdrawalService;
  let users: UsersService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;
  let approverId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }), config, TEST_JWT_SECRET);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
    users = new UsersService(db);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  async function openBounty(submissionMode = 'DIRECT') {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, submissionMode, maxWinners: 1,
      submissionDeadline: inDays(7),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1000' },
    });
    const reward = await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId]);
    const rewardId = reward.rows[0].id;
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);
    return { bountyId, rewardId };
  }

  async function activeAgentWithKey(ownerId: string) {
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
       VALUES ($1, 'bot', $2, $3, 'ACTIVE', now()) RETURNING id`,
      [ownerId, unique('pk-'), `0x${unique()}`],
    );
    await db.query(
      `INSERT INTO agent_api_key (agent_id, key_prefix, key_hash, status, expires_at)
       VALUES ($1, 'nj_test', $2, 'ACTIVE', now() + interval '90 days')`,
      [agent.rows[0].id, unique('hash-')],
    );
    return agent.rows[0].id;
  }

  it('blocks while a payout is open, then withdraws: identity freed for re-signup, sessions/agents/keys revoked, pending applications withdrawn, history kept', async () => {
    // a builder who signed up with Google, onboarded, linked a wallet and owns an agent
    const googleId = unique('google-');
    const email = `${unique()}@example.test`;
    const builder = await auth.upsertGoogleUser(googleId, email);
    const nickname = unique('Wd_');
    await users.completeProfile(builder.id, nickname, 'bio', ['DEV']);
    await db.query(`INSERT INTO user_link (user_id, link_type, url) VALUES ($1, 'GITHUB', 'https://github.com/x')`, [builder.id]);
    const wallet = await createPrimaryWallet(db, builder.id);
    const session = await auth.issueSession(builder.id, false);
    const agentId = await activeAgentWithKey(builder.id);

    // a won bounty with a payout still in flight, and a pending application elsewhere
    const won = await openBounty();
    const application = await applications.apply(won.bountyId, builder.id, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(won.bountyId, builder.id, { submissionUrl: 'https://x.test/w', description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    const payout = await rewards.requestPayout(won.rewardId, submission.id, '1000', adminId);
    const pendingBounty = await openBounty();
    const pending = await applications.apply(pendingBounty.bountyId, builder.id, 'pending');

    await expect(withdrawal.withdraw(builder.id, 'not-me')).rejects.toMatchObject({ message: 'CONFIRM_NICKNAME_MISMATCH' });
    await expect(withdrawal.withdraw(builder.id, nickname)).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    await rewards.markApproved(payout.id, approverId);
    await expect(withdrawal.withdraw(builder.id, nickname)).rejects.toMatchObject({ message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' }); // APPROVED is not terminal
    await rewards.markPaid(payout.id, fakeTxHash(), adminId);

    await expect(withdrawal.withdraw(builder.id, ` ${nickname.toLowerCase()} `)).resolves.toEqual({ ok: true });

    const user = (await db.query<{ status: string; deleted_at: Date | null; google_id: string; email: string; nickname: string; bio: string }>(
      `SELECT status, deleted_at, google_id, email, nickname, bio FROM "user" WHERE id = $1`, [builder.id])).rows[0];
    expect(user.status).toBe('WITHDRAWN');
    expect(user.deleted_at).toBeInstanceOf(Date);
    expect(user.google_id).toMatch(new RegExp(`^deleted:\\d+:${googleId}$`));
    expect(user.email).toMatch(new RegExp(`^deleted:\\d+:${email.replace('.', '\\.')}$`));
    expect(user.nickname).toMatch(/^withdrawn_[0-9a-f]{8}$/);
    expect(user.bio).toBe('');
    expect((await db.query(`SELECT 1 FROM user_link WHERE user_id = $1 UNION ALL SELECT 1 FROM user_tag WHERE user_id = $1`, [builder.id])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM auth_session WHERE user_id = $1 AND revoked_at IS NULL`, [builder.id])).rowCount).toBe(0);
    await expect(auth.refresh(session.refreshToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.assertActiveUser(builder.id)).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' }); // cache forgotten
    expect((await db.query<{ status: string }>(`SELECT status FROM agent WHERE id = $1`, [agentId])).rows[0].status).toBe('REVOKED');
    expect((await db.query<{ status: string }>(`SELECT status FROM agent_api_key WHERE agent_id = $1`, [agentId])).rows.map((r) => r.status)).toEqual(['REVOKED']);
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [pending.id])).rows[0].status).toBe('WITHDRAWN');
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [application.id])).rows[0].status).toBe('APPROVED');
    // history stays
    expect((await db.query<{ status: string }>(`SELECT status FROM payout WHERE id = $1`, [payout.id])).rows[0].status).toBe('PAID');
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_submission WHERE id = $1`, [submission.id])).rows[0].status).toBe('APPROVED');
    expect(await auditActions(db, 'user', builder.id)).toEqual(['USER_WITHDRAWN']);
    expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_REVOKED']);

    // public profile is gone, the nickname and the wallet address are free again
    await expect(users.publicProfile(nickname)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    await expect(users.publicProfile(user.nickname)).rejects.toMatchObject({ message: 'USER_NOT_FOUND' });
    expect(await users.nicknameAvailable(nickname)).toBe(true);

    // the same Google account signs up again as a new, unconnected user
    const again = await auth.upsertGoogleUser(googleId, email);
    expect(again.id).not.toBe(builder.id);
    expect(again.onboarding_step).toBe(2);
    await users.completeProfile(again.id, nickname, 'new bio', ['DESIGN']);
    await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now())`, [again.id, wallet.address]);

    // a second withdrawal of the same (already withdrawn) account is 404
    await expect(withdrawal.withdraw(builder.id, user.nickname)).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
  });

  it('a payout sent to my wallet for my agent\'s submission also blocks', async () => {
    const owner = await createUser(db);
    await createPrimaryWallet(db, owner);
    const agentId = await activeAgentWithKey(owner);
    const { bountyId, rewardId } = await openBounty('AGENT');
    const application = await applications.applyAsAgent(bountyId, agentId, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submitAsAgent(bountyId, agentId, { submissionUrl: 'https://x.test/a', description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    await rewards.requestPayout(rewardId, submission.id, '10', adminId);
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [owner])).rows[0].nickname;
    await expect(withdrawal.withdraw(owner, nickname)).rejects.toMatchObject({ message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
  });

  async function approvedWinner(submissionMode = 'DIRECT') {
    const builder = await createUser(db);
    await createPrimaryWallet(db, builder);
    const won = await openBounty(submissionMode);
    const application = await applications.apply(won.bountyId, builder, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(won.bountyId, builder, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [builder])).rows[0].nickname;
    return { builder, nickname, submissionId: submission.id, ...won };
  }

  it('an approved submission with a funded reward and no payout yet blocks withdrawal (409 PENDING_REWARDS) until it is paid', async () => {
    const { builder, nickname, submissionId, rewardId } = await approvedWinner();
    await expect(withdrawal.withdraw(builder, nickname)).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
    expect((await db.query<{ status: string }>(`SELECT status FROM "user" WHERE id = $1`, [builder])).rows[0].status).toBe('ACTIVE');

    const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
    await expect(withdrawal.withdraw(builder, nickname)).rejects.toMatchObject({ message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    await rewards.markApproved(payout.id, approverId);
    await rewards.markPaid(payout.id, fakeTxHash(), adminId);
    await expect(withdrawal.withdraw(builder, nickname)).resolves.toEqual({ ok: true });
  });

  it('my agent\'s approved, unrequested submission blocks too', async () => {
    const owner = await createUser(db);
    await createPrimaryWallet(db, owner);
    const agentId = await activeAgentWithKey(owner);
    const { bountyId } = await openBounty('AGENT');
    const application = await applications.applyAsAgent(bountyId, agentId, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submitAsAgent(bountyId, agentId, { submissionUrl: 'https://x.test/agent-pending', description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [owner])).rows[0].nickname;
    await expect(withdrawal.withdraw(owner, nickname)).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
  });

  it.each([
    ['the bounty is finished (no payout can be requested any more)', `UPDATE bounty SET status = 'COMPLETED' WHERE id = $1`],
    ['the bounty is deleted', `UPDATE bounty SET deleted_at = now() WHERE id = $1`],
    ['the reward is not funded', `UPDATE bounty_reward SET status = 'DEPOSIT_PENDING' WHERE bounty_id = $1`],
    ['the reward pool is fully allocated to others', `UPDATE bounty_reward SET deposited_amount = 0 WHERE bounty_id = $1`],
  ])('does not block when %s', async (_label, sql) => {
    const { builder, nickname, bountyId } = await approvedWinner();
    await db.query(sql, [bountyId]);
    await expect(withdrawal.withdraw(builder, nickname)).resolves.toEqual({ ok: true });
  });

  it('does not block on a submission whose payout was cancelled (requestPayout cannot re-request it)', async () => {
    const { builder, nickname, submissionId, rewardId } = await approvedWinner();
    const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
    await db.query(`UPDATE payout SET status = 'CANCELLED' WHERE id = $1`, [payout.id]); // manual ops action — no API sets it
    await expect(rewards.requestPayout(rewardId, submissionId, '1000', adminId)).rejects.toMatchObject({ message: 'PAYOUT_ALREADY_REQUESTED' });
    await expect(withdrawal.withdraw(builder, nickname)).resolves.toEqual({ ok: true });
  });

  it('a FAILED payout does not block withdrawal (terminal, and it cannot be re-requested) — unchanged by the payout-status.ts refactor', async () => {
    const { builder, nickname, submissionId, rewardId } = await approvedWinner();
    const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
    await expect(withdrawal.withdraw(builder, nickname)).rejects.toMatchObject({ message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    await db.query(`UPDATE payout SET status = 'FAILED' WHERE id = $1`, [payout.id]); // manual ops action — no API sets it
    await expect(withdrawal.withdraw(builder, nickname)).resolves.toEqual({ ok: true });
  });

  it('headroom released by cancelling someone else\'s award blocks an approved, unrequested winner again (409 PENDING_REWARDS)', async () => {
    const first = await approvedWinner();
    await db.query(`UPDATE bounty SET max_winners = 2 WHERE id = $1`, [first.bountyId]);
    const other = await createUser(db);
    await createPrimaryWallet(db, other);
    const application = await applications.apply(first.bountyId, other, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(first.bountyId, other, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    const otherNickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [other])).rows[0].nickname;

    // the whole pool goes to the first winner (no headroom → the other winner would not be blocked), then that award is cancelled
    const payout = await rewards.requestPayout(first.rewardId, first.submissionId, '1000', adminId);
    await db.query(`UPDATE payout SET status = 'CANCELLED' WHERE id = $1`, [payout.id]); // runbook §7.4
    await expect(withdrawal.withdraw(other, otherNickname)).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
    await expect(withdrawal.withdraw(first.builder, first.nickname)).resolves.toEqual({ ok: true }); // cancelled → nothing to wait for
  });

  it('withdraws submissions still under review (they can no longer be approved or block completion); reviewed ones stay', async () => {
    const builder = await createUser(db);
    await createPrimaryWallet(db, builder);
    const open = await openBounty();
    const application = await applications.apply(open.bountyId, builder, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(open.bountyId, builder, { submissionUrl: 'https://x.test/open', description: 'd' });
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [builder])).rows[0].nickname;

    await expect(withdrawal.withdraw(builder, nickname)).resolves.toEqual({ ok: true });

    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_submission WHERE id = $1`, [submission.id])).rows[0].status).toBe('WITHDRAWN');
    await expect(submissionReview.review(submission.id, 'APPROVE', undefined, adminId)).rejects.toBeDefined();
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [application.id])).rows[0].status).toBe('APPROVED');
  });

  it('a payout request racing a withdrawal waits for it and then refuses (no open payout to a withdrawn user)', async () => {
    const builder = await createUser(db);
    await createPrimaryWallet(db, builder);
    const won = await openBounty();
    const application = await applications.apply(won.bountyId, builder, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(won.bountyId, builder, { submissionUrl: 'https://x.test/race', description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);

    // Hold the withdrawal's first lock (the user row, FOR UPDATE) open in another transaction, start the payout request,
    // then finish the withdrawal's writes and commit.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const withdrawing = db.tx(async (tx) => {
      await tx.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [builder]);
      locked();
      await released;
      await tx.query(`UPDATE "user" SET status = 'WITHDRAWN', deleted_at = now() WHERE id = $1`, [builder]);
      await tx.query(`UPDATE wallet SET disconnected_at = now() WHERE user_id = $1`, [builder]);
    });
    await isLocked;
    let settled = false;
    const request = rewards.requestPayout(won.rewardId, submission.id, '1000', adminId).finally(() => { settled = true; });
    request.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false); // blocked on the user row
    release();
    await withdrawing;
    await expect(request).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND' });
    expect((await db.query(`SELECT 1 FROM payout WHERE submission_id = $1`, [submission.id])).rowCount).toBe(0);
  });
  it('an approval racing a withdrawal waits for it and then refuses (no approved winner who can never be paid)', async () => {
    const builder = await createUser(db);
    await createPrimaryWallet(db, builder);
    const open = await openBounty();
    const application = await applications.apply(open.bountyId, builder, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(open.bountyId, builder, { submissionUrl: 'https://x.test/race-approve', description: 'd' });

    // the withdrawal's first lock (the user row, FOR UPDATE) is held while the approval starts; the submission row stays untouched
    // here (the real withdrawal would only withdraw it after this lock, which is exactly the window the approval used to slip through)
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const withdrawing = db.tx(async (tx) => {
      await tx.query(`SELECT id FROM "user" WHERE id = $1 FOR UPDATE`, [builder]);
      locked();
      await released;
      await tx.query(`UPDATE "user" SET status = 'WITHDRAWN', deleted_at = now() WHERE id = $1`, [builder]);
    });
    await isLocked;
    let settled = false;
    const approval = submissionReview.review(submission.id, 'APPROVE', undefined, adminId).finally(() => { settled = true; });
    approval.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false); // blocked on the user row
    release();
    await withdrawing;
    await expect(approval).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_submission WHERE id = $1`, [submission.id])).rows[0].status).toBe('SUBMITTED');
    expect(await auditActions(db, 'bounty_submission', submission.id)).toEqual([]);
  });

  it('a withdrawal racing an approval waits for it and then refuses with WITHDRAWAL_BLOCKED_PENDING_REWARDS', async () => {
    const builder = await createUser(db);
    await createPrimaryWallet(db, builder);
    const open = await openBounty();
    const application = await applications.apply(open.bountyId, builder, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(open.bountyId, builder, { submissionUrl: 'https://x.test/race-withdraw', description: 'd' });
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [builder])).rows[0].nickname;

    // the approval holds the user row FOR SHARE until it commits; park it just before the commit by holding the shared lock in our own tx
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const approving = db.tx(async (tx) => {
      await tx.query(`SELECT id FROM "user" WHERE id = $1 FOR SHARE`, [builder]);
      await tx.query(`UPDATE bounty_submission SET status = 'APPROVED' WHERE id = $1`, [submission.id]);
      locked();
      await released;
    });
    await isLocked;
    let settled = false;
    const withdrawing = withdrawal.withdraw(builder, nickname).finally(() => { settled = true; });
    withdrawing.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false); // blocked on the user row
    release();
    await approving;
    await expect(withdrawing).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
    expect((await db.query<{ status: string }>(`SELECT status FROM "user" WHERE id = $1`, [builder])).rows[0].status).toBe('ACTIVE');
  });

  it('approving an agent submission whose owner is gone is refused too (the owner row is the one locked)', async () => {
    const owner = await createUser(db);
    await createPrimaryWallet(db, owner);
    const agentId = await activeAgentWithKey(owner);
    const open = await openBounty('AGENT');
    const sid = (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, agent_id, submission_url, description, status) VALUES ($1, $2, 'https://x.test/a', 'd', 'SUBMITTED') RETURNING id`,
      [open.bountyId, agentId])).rows[0].id;
    await db.query(`INSERT INTO submission_revision (submission_id, revision_no, submission_url, description, created_by_agent_id) VALUES ($1, 1, 'https://x.test/a', 'd', $2)`, [sid, agentId]);

    await db.query(`UPDATE "user" SET status = 'WITHDRAWN', deleted_at = now() WHERE id = $1`, [owner]);
    await expect(submissionReview.review(sid, 'APPROVE', undefined, adminId)).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    // rejecting it stays possible
    await expect(submissionReview.review(sid, 'REJECT', undefined, adminId)).resolves.toMatchObject({ status: 'REJECTED' });
  });
});
