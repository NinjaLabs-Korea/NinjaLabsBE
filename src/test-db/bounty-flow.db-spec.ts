import { ConflictException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
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
import { UsersService } from '../users/users.service';
import { inspectReward } from '../../scripts/record-refund';
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser, deferred, fakeTxHash, testConfig, unique, waitForLockWaiter } from './harness';

describeDb('bounty → reward → payout → child NFT on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let nfts: NftsService;
  let applications: ApplicationsService;
  let applicationReview: ApplicationReviewService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;
  /** second admin — the two-person rule forbids the requesting admin (adminId) from approving their own payout */
  let approverId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    nfts = new NftsService(db, config);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, nfts, audit, config);
    applications = new ApplicationsService(db, audit);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  async function createFundedBounty(options: { maxWinners?: number; amount?: string } = {}) {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('bounty-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: true, submissionMode: 'DIRECT', maxWinners: options.maxWinners ?? 1,
      submissionDeadline: inDays(7),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: options.amount ?? '1000' },
    });
    const reward = await db.query<{ id: string; status: string; custody_address: string }>(
      `SELECT id, status, custody_address FROM bounty_reward WHERE bounty_id = $1`, [bountyId]);
    expect(reward.rows[0]).toMatchObject({ status: 'DEPOSIT_PENDING', custody_address: 'inj1testmultisig' });
    return { bountyId, rewardId: reward.rows[0].id };
  }

  async function bountyStatus(bountyId: string) {
    const r = await db.query<{ status: string; opened_at: Date | null; completed_at: Date | null }>(
      `SELECT status, opened_at, completed_at FROM bounty WHERE id = $1`, [bountyId]);
    return r.rows[0];
  }

  async function rewardRow(rewardId: string) {
    const r = await db.query<{ status: string; deposit_tx_hash: string | null; deposited_amount: string }>(
      `SELECT status, deposit_tx_hash, deposited_amount::text FROM bounty_reward WHERE id = $1`, [rewardId]);
    return r.rows[0];
  }

  it('runs the full admin flow and ends with reward PAID plus a MINT_CHILD job linked to the parent NFT', async () => {
    const { bountyId, rewardId } = await createFundedBounty();
    expect((await bountyStatus(bountyId)).status).toBe('FUNDING_PENDING');

    // OPEN is blocked until the deposit is confirmed
    // lifecycle blockers are returned as the 400 body's message array
    await expect(bounties.transition(bountyId, 'OPEN', adminId)).rejects.toMatchObject({
      response: { message: [expect.stringContaining('Confirm all reward deposits')] },
    });

    const depositHash = fakeTxHash();
    await expect(rewards.confirmDeposit(rewardId, depositHash, '999', adminId)).rejects.toMatchObject({ message: 'DEPOSIT_BELOW_REWARD_AMOUNT' }); // short deposit
    await expect(rewards.confirmDeposit(rewardId, depositHash, '1000', adminId)).resolves.toMatchObject({ id: rewardId, status: 'FUNDED' });
    expect(await rewardRow(rewardId)).toEqual({ status: 'FUNDED', deposit_tx_hash: `0x${depositHash.slice(2).toLowerCase()}`, deposited_amount: '1000' });
    await expect(rewards.confirmDeposit(rewardId, depositHash, '1000', adminId)).rejects.toMatchObject({ message: 'REWARD_NOT_FOUND_OR_NOT_PENDING' }); // idempotent-ish

    // the same deposit hash on a second reward is refused by uq_bounty_reward_deposit_tx (case/prefix variants collapse)
    const other = await createFundedBounty();
    await expect(rewards.confirmDeposit(other.rewardId, depositHash.toLowerCase(), '1000', adminId)).rejects.toMatchObject({ message: 'TX_HASH_ALREADY_USED' });
    expect((await rewardRow(other.rewardId)).status).toBe('DEPOSIT_PENDING');

    await expect(bounties.transition(bountyId, 'OPEN', adminId)).resolves.toEqual({ id: bountyId, status: 'OPEN' });
    expect((await bountyStatus(bountyId)).opened_at).toBeInstanceOf(Date);

    // builder: application → approval → submission → approval
    const builderId = await createUser(db);
    const builderWallet = await createPrimaryWallet(db, builderId);
    const parent = await nfts.enqueueParentMint(builderId, builderWallet.id);
    expect(parent).toEqual({ nftId: expect.any(String) });
    expect(await nfts.enqueueParentMint(builderId, builderWallet.id)).toBeNull(); // one parent per user

    await expect(submissions.submit(bountyId, builderId, { submissionUrl: 'https://x.test/w', description: 'early' })).rejects.toMatchObject({ message: 'APPLICATION_NOT_APPROVED' });
    const application = await applications.apply(bountyId, builderId, 'let me in');
    expect(application.status).toBe('PENDING');
    await expect(applications.apply(bountyId, builderId, 'again')).rejects.toMatchObject({ message: 'ALREADY_APPLIED' });
    await expect(bounties.transition(bountyId, 'SUBMISSION_CLOSED', adminId)).rejects.toMatchObject({
      response: { message: expect.arrayContaining([expect.stringContaining('pending application')]) },
    });
    await expect(applicationReview.review(application.id, 'APPROVED', 'ok', adminId)).resolves.toEqual({ id: application.id, status: 'APPROVED' });
    await expect(applicationReview.review(application.id, 'APPROVED', 'twice', adminId)).rejects.toMatchObject({ message: 'APPLICATION_NOT_FOUND_OR_NOT_PENDING' });

    const submitted = await submissions.submit(bountyId, builderId, { submissionUrl: 'https://x.test/work', description: 'done' });
    expect(submitted).toEqual({ id: expect.any(String), revisionNo: 1, status: 'SUBMITTED' });
    const resubmitted = await submissions.submit(bountyId, builderId, { submissionUrl: 'https://x.test/work2', description: 'polished', commitSha: 'abc' });
    expect(resubmitted).toEqual({ id: submitted.id, revisionNo: 2, status: 'RESUBMITTED' });
    const revisions = await db.query<{ revision_no: number }>(`SELECT revision_no FROM submission_revision WHERE submission_id = $1 ORDER BY revision_no`, [submitted.id]);
    expect(revisions.rows.map((row) => row.revision_no)).toEqual([1, 2]);

    await expect(submissionReview.review(submitted.id, 'APPROVE', 'great', adminId, 1)).rejects.toMatchObject({ message: 'SUBMISSION_REVISION_CHANGED' });
    await expect(submissionReview.review(submitted.id, 'APPROVE', 'great', adminId, 2)).resolves.toEqual({ id: submitted.id, status: 'APPROVED' });
    await expect(submissions.submit(bountyId, builderId, { submissionUrl: 'https://x.test/w3', description: 'late' })).rejects.toMatchObject({ message: 'SUBMISSION_FINALIZED' });

    // payout: request → approve → paid
    const payout = await rewards.requestPayout(rewardId, submitted.id, '1000', adminId);
    expect(payout.status).toBe('REQUESTED');
    await expect(rewards.requestPayout(rewardId, submitted.id, '1', adminId)).rejects.toMatchObject({ message: 'PAYOUT_ALREADY_REQUESTED' });
    await expect(rewards.markPaid(payout.id, fakeTxHash(), adminId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' }); // not approved yet
    await expect(rewards.markApproved(payout.id, approverId)).resolves.toEqual({ id: payout.id, status: 'APPROVED' });

    const payoutHash = fakeTxHash();
    const paid = await rewards.markPaid(payout.id, payoutHash, adminId);
    expect(paid).toMatchObject({ id: payout.id, status: 'PAID', payout_tx_hash: `0x${payoutHash.slice(2).toLowerCase()}`, submission_id: submitted.id, recipient_wallet_id: builderWallet.id });

    // advanceRewardStatus: one winner paid out of max_winners 1 → PAID
    expect((await rewardRow(rewardId)).status).toBe('PAID');

    // child NFT + MINT_CHILD job, linked to the parent NFT
    const child = await db.query<{ id: string; parent_nft_id: string; bounty_id: string; status: string }>(
      `SELECT id, parent_nft_id, bounty_id, status FROM nft WHERE submission_id = $1 AND nft_type = 'BOUNTY_COMPLETION_CHILD'`, [submitted.id]);
    expect(child.rows).toEqual([{ id: expect.any(String), parent_nft_id: parent!.nftId, bounty_id: bountyId, status: 'PENDING' }]);
    const job = await db.query<{ job_type: string; idempotency_key: string; status: string }>(
      `SELECT job_type, idempotency_key, status FROM nft_job WHERE nft_id = $1`, [child.rows[0].id]);
    expect(job.rows).toEqual([{ job_type: 'MINT_CHILD', idempotency_key: `mint-child:${submitted.id}`, status: 'PENDING' }]);

    // the same payout hash cannot be recorded on a payout of a *different* bounty (same-bounty reuse is the multi-send case below)
    const second = await createFundedBounty();
    await rewards.confirmDeposit(second.rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(second.bountyId, 'OPEN', adminId);
    const app2 = await applications.apply(second.bountyId, builderId, 'me again');
    await applicationReview.review(app2.id, 'APPROVED', undefined, adminId);
    const sub2 = await submissions.submit(second.bountyId, builderId, { submissionUrl: 'https://x.test/2', description: 'd' });
    await submissionReview.review(sub2.id, 'APPROVE', undefined, adminId);
    const payout2 = await rewards.requestPayout(second.rewardId, sub2.id, '1000', adminId);
    await rewards.markApproved(payout2.id, approverId);
    await expect(rewards.markPaid(payout2.id, payoutHash.toLowerCase(), adminId)).rejects.toMatchObject({ message: 'TX_HASH_ALREADY_USED' });
    const payout2Row = await db.query<{ status: string }>(`SELECT status FROM payout WHERE id = $1`, [payout2.id]);
    expect(payout2Row.rows[0].status).toBe('APPROVED'); // rolled back

    // lifecycle to COMPLETED now has no blockers
    await expect(bounties.transition(bountyId, 'SUBMISSION_CLOSED', adminId)).resolves.toEqual({ id: bountyId, status: 'SUBMISSION_CLOSED' });
    await expect(bounties.transition(bountyId, 'IN_REVIEW', adminId)).resolves.toEqual({ id: bountyId, status: 'IN_REVIEW' });
    await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
    expect((await bountyStatus(bountyId)).completed_at).toBeInstanceOf(Date);
    await expect(bounties.transition(bountyId, 'OPEN', adminId)).rejects.toMatchObject({ message: 'INVALID_TRANSITION:COMPLETED->OPEN' });

    expect(await auditActions(db, 'bounty', bountyId)).toEqual([
      'BOUNTY_CREATED', 'BOUNTY_OPEN', 'BOUNTY_SUBMISSION_CLOSED', 'BOUNTY_IN_REVIEW', 'BOUNTY_COMPLETED',
    ]);
    expect(await auditActions(db, 'bounty_reward', rewardId)).toEqual(['REWARD_DEPOSIT_CONFIRMED']);
    expect(await auditActions(db, 'payout', payout.id)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED', 'PAYOUT_PAID']);
    expect(await auditActions(db, 'bounty_submission', submitted.id)).toEqual(['SUBMISSION_APPROVE']);
    expect(await auditActions(db, 'bounty_application', application.id)).toEqual(['APPLICATION_APPROVED']);
  });

  it('advanceRewardStatus leaves a multi-winner reward PARTIALLY_PAID until the pool or the winner count is exhausted', async () => {
    const { bountyId, rewardId } = await createFundedBounty({ maxWinners: 2, amount: '1000' });
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);

    const winners = [] as Array<{ submissionId: string }>;
    for (let i = 0; i < 2; i++) {
      const builderId = await createUser(db);
      await createPrimaryWallet(db, builderId);
      const application = await applications.apply(bountyId, builderId, 'hi');
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
      const submission = await submissions.submit(bountyId, builderId, { submissionUrl: `https://x.test/${i}`, description: 'd' });
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      winners.push({ submissionId: submission.id });
    }
    // a third approval would exceed max_winners
    const extraId = await createUser(db);
    const extraApp = await applications.apply(bountyId, extraId, 'late');
    await applicationReview.review(extraApp.id, 'APPROVED', undefined, adminId);
    const extraSub = await submissions.submit(bountyId, extraId, { submissionUrl: 'https://x.test/extra', description: 'd' });
    await expect(submissionReview.review(extraSub.id, 'APPROVE', undefined, adminId)).rejects.toMatchObject({ message: 'MAX_WINNERS_REACHED' });

    // one multisig tx pays both winners → the same hash is recorded on both payouts of this bounty
    const multiSendHash = fakeTxHash();
    const first = await rewards.requestPayout(rewardId, winners[0].submissionId, '400', adminId);
    await rewards.markApproved(first.id, approverId);
    await rewards.markPaid(first.id, multiSendHash, adminId);
    expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID');

    await expect(rewards.requestPayout(rewardId, winners[1].submissionId, '601', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    const second = await rewards.requestPayout(rewardId, winners[1].submissionId, '600', adminId);
    await rewards.markApproved(second.id, approverId);
    await expect(rewards.markPaid(second.id, multiSendHash.toLowerCase(), adminId)).resolves.toMatchObject({ id: second.id, status: 'PAID' });
    expect((await rewardRow(rewardId)).status).toBe('PAID');
    const paidHashes = await db.query<{ payout_tx_hash: string }>(`SELECT payout_tx_hash FROM payout WHERE bounty_reward_id = $1 AND status = 'PAID'`, [rewardId]);
    expect(paidHashes.rows.map((row) => row.payout_tx_hash)).toEqual([`0x${multiSendHash.slice(2).toLowerCase()}`, `0x${multiSendHash.slice(2).toLowerCase()}`]);

    const childJobs = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nft_job j JOIN nft n ON n.id = j.nft_id WHERE n.bounty_id = $1 AND j.job_type = 'MINT_CHILD'`, [bountyId]);
    expect(childJobs.rows[0].n).toBe(2);
  });

  it('re-applying after withdrawal reopens the same row (PENDING, new message, review fields cleared, APPLICATION_REAPPLIED) only while the bounty accepts applications', async () => {
    const { bountyId, rewardId } = await createFundedBounty();
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);
    const builderId = await createUser(db);

    const first = await applications.apply(bountyId, builderId, 'first try', 'https://x.test/old');
    await expect(applications.withdraw(first.id, builderId)).resolves.toEqual({ id: first.id, status: 'WITHDRAWN' });
    // simulate leftover review fields (e.g. an older review cycle) — re-application must clear them
    await db.query(`UPDATE bounty_application SET reviewed_by = $2, reviewed_at = now(), review_note = 'old note', applied_at = now() - interval '1 day' WHERE id = $1`, [first.id, adminId]);

    const reopened = await applications.apply(bountyId, builderId, 'second try');
    expect(reopened).toEqual({ id: first.id, status: 'PENDING', applied_at: expect.any(Date) });
    const row = await db.query(`SELECT status, message, portfolio_url, reviewed_by, reviewed_at, review_note, applied_at > now() - interval '1 minute' AS fresh
      FROM bounty_application WHERE id = $1`, [first.id]);
    expect(row.rows[0]).toEqual({ status: 'PENDING', message: 'second try', portfolio_url: null, reviewed_by: null, reviewed_at: null, review_note: null, fresh: true });
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty_application WHERE bounty_id = $1 AND applicant_user_id = $2`, [bountyId, builderId]);
    expect(count.rows[0].n).toBe(1);
    expect(await auditActions(db, 'bounty_application', first.id)).toEqual(['APPLICATION_REAPPLIED']);

    // a PENDING (or reviewed) application is still a conflict
    await expect(applications.apply(bountyId, builderId, 'third')).rejects.toMatchObject({ message: 'ALREADY_APPLIED' });
    await applicationReview.review(first.id, 'REJECTED', 'no', adminId);
    await expect(applications.apply(bountyId, builderId, 'after reject')).rejects.toMatchObject({ message: 'ALREADY_APPLIED' });

    // withdrawn on a bounty that no longer accepts applications → same checks as a new application, row stays WITHDRAWN
    const other = await createFundedBounty();
    await rewards.confirmDeposit(other.rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(other.bountyId, 'OPEN', adminId);
    const app2 = await applications.apply(other.bountyId, builderId, 'x');
    await applications.withdraw(app2.id, builderId);
    await db.query(`UPDATE bounty SET application_deadline = now() - interval '1 minute' WHERE id = $1`, [other.bountyId]);
    await expect(applications.apply(other.bountyId, builderId, 'late')).rejects.toMatchObject({ message: 'APPLICATION_DEADLINE_PASSED' });
    await db.query(`UPDATE bounty SET application_deadline = NULL WHERE id = $1`, [other.bountyId]);
    await bounties.transition(other.bountyId, 'SUBMISSION_CLOSED', adminId);
    await expect(applications.apply(other.bountyId, builderId, 'closed')).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect((await db.query<{ status: string }>(`SELECT status FROM bounty_application WHERE id = $1`, [app2.id])).rows[0].status).toBe('WITHDRAWN');
  });

  async function approvedWinner(bountyId: string, index: number): Promise<string> {
    const builderId = await createUser(db);
    await createPrimaryWallet(db, builderId);
    const application = await applications.apply(bountyId, builderId, 'hi');
    await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
    const submission = await submissions.submit(bountyId, builderId, { submissionUrl: `https://x.test/w${index}`, description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    return submission.id;
  }

  it('a PAID reward accepts another payout while headroom remains after the admin raises maxWinners, and drops back to PARTIALLY_PAID until it is paid', async () => {
    const { bountyId, rewardId } = await createFundedBounty({ maxWinners: 1, amount: '1000' });
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);

    const firstSubmission = await approvedWinner(bountyId, 1);
    const first = await rewards.requestPayout(rewardId, firstSubmission, '400', adminId);
    expect((await rewardRow(rewardId)).status).toBe('FUNDED'); // a request alone is not a partial payment
    await rewards.markApproved(first.id, approverId);
    await rewards.markPaid(first.id, fakeTxHash(), adminId);
    expect((await rewardRow(rewardId)).status).toBe('PAID'); // 1 winner paid of max_winners 1, even though 600 is left

    // the admin decides on a second winner: raise maxWinners, approve another submission
    await bounties.update(bountyId, { maxWinners: 2 }, adminId);
    const secondSubmission = await approvedWinner(bountyId, 2);

    await expect(rewards.requestPayout(rewardId, secondSubmission, '601', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    const second = await rewards.requestPayout(rewardId, secondSubmission, '600', adminId);
    expect(second.status).toBe('REQUESTED');
    expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID'); // back from PAID: a payout is open again

    await rewards.markApproved(second.id, approverId);
    await rewards.markPaid(second.id, fakeTxHash(), adminId);
    expect((await rewardRow(rewardId)).status).toBe('PAID');

    // pool exhausted: a third winner cannot be paid even if maxWinners were raised again
    await bounties.update(bountyId, { maxWinners: 3 }, adminId);
    const thirdSubmission = await approvedWinner(bountyId, 3);
    await expect(rewards.requestPayout(rewardId, thirdSubmission, '1', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    expect((await rewardRow(rewardId)).status).toBe('PAID');
  });

  describe('payout policy (2026-10-24): two-person approval, allocation cap, delete guard', () => {
    async function openWithWinner(amount = '1000', deposit = amount) {
      const { bountyId, rewardId } = await createFundedBounty({ amount });
      await rewards.confirmDeposit(rewardId, fakeTxHash(), deposit, adminId);
      await bounties.transition(bountyId, 'OPEN', adminId);
      const submissionId = await approvedWinner(bountyId, 1);
      return { bountyId, rewardId, submissionId };
    }

    it('the requesting admin cannot approve their own payout (403 PAYOUT_SELF_APPROVAL); another admin can, and approved_by is stored', async () => {
      const { rewardId, submissionId } = await openWithWinner();
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await expect(rewards.markApproved(payout.id, adminId)).rejects.toMatchObject({ status: 403, message: 'PAYOUT_SELF_APPROVAL' });
      const before = await db.query(`SELECT status, requested_by, approved_by FROM payout WHERE id = $1`, [payout.id]);
      expect(before.rows[0]).toEqual({ status: 'REQUESTED', requested_by: adminId, approved_by: null });
      await expect(rewards.markApproved(payout.id, approverId)).resolves.toEqual({ id: payout.id, status: 'APPROVED' });
      const after = await db.query(`SELECT status, approved_by FROM payout WHERE id = $1`, [payout.id]);
      expect(after.rows[0]).toEqual({ status: 'APPROVED', approved_by: approverId });
      expect(await auditActions(db, 'payout', payout.id)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED']);
    });

    it('PAYOUT_ALLOW_SELF_APPROVAL=true lets a solo operator approve their own payout, audited as PAYOUT_SELF_APPROVED', async () => {
      const solo = new RewardsService(db, nfts, new AuditService(db), testConfig({ PAYOUT_ALLOW_SELF_APPROVAL: 'true' }));
      const { rewardId, submissionId } = await openWithWinner();
      const payout = await solo.requestPayout(rewardId, submissionId, '1000', adminId);
      await expect(solo.markApproved(payout.id, adminId)).resolves.toEqual({ id: payout.id, status: 'APPROVED' });
      expect(await auditActions(db, 'payout', payout.id)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_SELF_APPROVED']);
    });

    it('an over-deposit does not raise the allocation cap: sum + amount ≤ LEAST(amount, deposited_amount); paying the posted amount ends PAID', async () => {
      const { rewardId, submissionId } = await openWithWinner('1000', '1500');
      expect((await rewardRow(rewardId)).deposited_amount).toBe('1500');
      await expect(rewards.requestPayout(rewardId, submissionId, '1001', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await rewards.markApproved(payout.id, approverId);
      await rewards.markPaid(payout.id, fakeTxHash(), adminId);
      expect((await rewardRow(rewardId)).status).toBe('PAID');
    });

    it('PAID-with-headroom uses the same cap: after maxWinners is raised, the over-deposited surplus is not allocatable', async () => {
      const { bountyId, rewardId, submissionId } = await openWithWinner('1000', '1500');
      const first = await rewards.requestPayout(rewardId, submissionId, '600', adminId);
      await rewards.markApproved(first.id, approverId);
      await rewards.markPaid(first.id, fakeTxHash(), adminId);
      expect((await rewardRow(rewardId)).status).toBe('PAID'); // max_winners 1 reached
      await bounties.update(bountyId, { maxWinners: 2 }, adminId);
      const second = await approvedWinner(bountyId, 2);
      await expect(rewards.requestPayout(rewardId, second, '401', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' }); // 900 would fit the deposit
      await expect(rewards.requestPayout(rewardId, second, '400', adminId)).resolves.toMatchObject({ status: 'REQUESTED' });
    });

    it('DELETE refuses 409 BOUNTY_HAS_OPEN_FUNDS while funds are held or a payout is open; allows DEPOSIT_PENDING, fully PAID, REFUNDED; a deleted bounty takes no deposit', async () => {
      // DEPOSIT_PENDING only → allowed; its reward can no longer be confirmed
      const pending = await createFundedBounty();
      await expect(bounties.remove(pending.bountyId, adminId)).resolves.toEqual({ id: pending.bountyId });
      await expect(rewards.confirmDeposit(pending.rewardId, fakeTxHash(), '1000', adminId)).rejects.toMatchObject({ message: 'REWARD_NOT_FOUND_OR_NOT_PENDING' });

      // FUNDED → refused
      const { bountyId, rewardId, submissionId } = await openWithWinner();
      await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ status: 409, message: 'BOUNTY_HAS_OPEN_FUNDS' });
      // REQUESTED / APPROVED payout → refused
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      await rewards.markApproved(payout.id, approverId);
      await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      // fully PAID → allowed
      await rewards.markPaid(payout.id, fakeTxHash(), adminId);
      expect((await rewardRow(rewardId)).status).toBe('PAID');
      await expect(bounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
      expect(await auditActions(db, 'bounty', bountyId)).toContain('BOUNTY_DELETED');

      // PAID with headroom (600 left in custody) → refused
      const partial = await openWithWinner();
      const p1 = await rewards.requestPayout(partial.rewardId, partial.submissionId, '400', adminId);
      await rewards.markApproved(p1.id, approverId);
      await rewards.markPaid(p1.id, fakeTxHash(), adminId);
      expect((await rewardRow(partial.rewardId)).status).toBe('PAID');
      await expect(bounties.remove(partial.bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      // the operator refunds the remainder → REFUND_PENDING still blocks, REFUNDED allows
      await db.query(`UPDATE bounty_reward SET status = 'REFUND_PENDING' WHERE id = $1`, [partial.rewardId]);
      await expect(bounties.remove(partial.bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      await db.query(`UPDATE bounty_reward SET status = 'REFUNDED' WHERE id = $1`, [partial.rewardId]);
      await expect(bounties.remove(partial.bountyId, adminId)).resolves.toEqual({ id: partial.bountyId });
      const deletedAudit = await auditActions(db, 'bounty', partial.bountyId);
      expect(deletedAudit.filter((a) => a === 'BOUNTY_DELETED')).toEqual(['BOUNTY_DELETED']);
    });
  });

  /**
   * 지급 취소/풀 소진 뒤에도 바운티를 끝낼 수 있다 - 규칙은 rewards/payout-status.ts (OPEN_PAYOUT_STATUSES, owesUnpaidRewardSql).
   *   - 취소된(CANCELLED) payout은 진행 중이 아니고, 그 수상자는 받을 몫이 없다(NONE) — 같은 (보상, 제출)로 다시 요청할 수 없으므로.
   *   - 다른 수상자가 풀을 다 가져간 승인 제출도 받을 몫이 없다(NONE).
   *   - 여유분이 남은 승인 제출, FAILED payout이 걸린 제출은 받을 몫이 남은 것이라 COMPLETED를 막는다 (PENDING).
   */
  describe('cancelled payouts and an exhausted pool do not block COMPLETED (runbook §7.4)', () => {
    async function winner(bountyId: string, index: number) {
      const nickname = `w${unique().replace(/-/g, '').slice(0, 12)}`;
      const userId = await createUser(db, { nickname });
      await createPrimaryWallet(db, userId);
      const application = await applications.apply(bountyId, userId, 'hi');
      await applicationReview.review(application.id, 'APPROVED', undefined, adminId);
      const submission = await submissions.submit(bountyId, userId, { submissionUrl: `https://x.test/c${index}`, description: 'd' });
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      return { userId, nickname, submissionId: submission.id };
    }

    async function openBounty(maxWinners: number) {
      const { bountyId, rewardId } = await createFundedBounty({ maxWinners, amount: '1000' });
      await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
      await bounties.transition(bountyId, 'OPEN', adminId);
      return { bountyId, rewardId };
    }

    async function pay(rewardId: string, submissionId: string, amount: string) {
      const payout = await rewards.requestPayout(rewardId, submissionId, amount, adminId);
      await rewards.markApproved(payout.id, approverId);
      await rewards.markPaid(payout.id, fakeTxHash(), adminId);
      return payout.id;
    }

    /** docs/runbook.md §7.4 "수상 자체를 취소" SQL 그대로 (payout id만 치환) — 문서의 절차가 실제로 바운티를 끝낼 수 있게 두는지 검사한다 */
    async function runbookCancel(payoutId: string) {
      await db.tx(async (tx) => {
        const cancelled = await tx.query(`UPDATE payout SET status = 'CANCELLED', last_error = 'award withdrawn'
          WHERE id = $1 AND status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED')`, [payoutId]);
        expect(cancelled.rowCount).toBe(1);
        await tx.query(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before_data, after_data)
          VALUES (NULL, 'PAYOUT_CANCELLED_MANUAL', 'payout', $1, '{"status": "REQUESTED"}', '{"status": "CANCELLED", "by": "ops a+b", "reason": "test"}')`, [payoutId]);
        await tx.query(`UPDATE bounty_reward rw
            SET status = CASE WHEN p.open_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= LEAST(rw.amount, rw.deposited_amount))
                              THEN 'PAID' ELSE 'PARTIALLY_PAID' END
           FROM bounty b,
                (SELECT count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
                        count(*) FILTER (WHERE status NOT IN ('PAID', 'CANCELLED'))::int AS open_count,
                        COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid_amount
                   FROM payout WHERE bounty_reward_id = (SELECT bounty_reward_id FROM payout WHERE id = $1)) p
          WHERE rw.id = (SELECT bounty_reward_id FROM payout WHERE id = $1) AND b.id = rw.bounty_id
            AND rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID') AND p.paid_count > 0`, [payoutId]);
      });
    }

    /** /submissions/me payment_status 와 GET /users/:nickname completedBounties[].payoutStatus — 둘 다 payoutStatusSql */
    async function shownStatus(who: { userId: string; nickname: string; submissionId: string }) {
      const mine = (await submissions.mySubmissions(who.userId)).find((row) => row.id === who.submissionId);
      const profile = await new UsersService(db, new AuditService(db)).publicProfile(who.nickname);
      return { me: mine?.payment_status, profile: profile.completedBounties.map((row: { payoutStatus: string }) => row.payoutStatus) };
    }

    async function toInReview(bountyId: string) {
      await bounties.transition(bountyId, 'SUBMISSION_CLOSED', adminId);
      await bounties.transition(bountyId, 'IN_REVIEW', adminId);
    }

    const UNPAID = { response: { message: ['Record completed payments for all approved winners and finish every pending payout.'] } };

    it('after the runbook cancel of one award: that winner shows NONE (not PENDING), and the bounty can be COMPLETED', async () => {
      const { bountyId, rewardId } = await openBounty(2);
      const a = await winner(bountyId, 1);
      const b = await winner(bountyId, 2);
      await pay(rewardId, a.submissionId, '500');
      const open = await rewards.requestPayout(rewardId, b.submissionId, '500', adminId);
      await toInReview(bountyId);

      // B's payout is still in flight → blocked, and B is owed
      expect(await shownStatus(b)).toEqual({ me: 'PENDING', profile: ['PENDING'] });
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID);

      await runbookCancel(open.id);
      expect(await shownStatus(b)).toEqual({ me: 'NONE', profile: ['NONE'] });
      expect(await shownStatus(a)).toEqual({ me: 'PAID', profile: ['PAID'] });
      // the cancelled award cannot be re-requested (any payout row for (reward, submission) is a duplicate)
      await expect(rewards.requestPayout(rewardId, b.submissionId, '500', adminId)).rejects.toMatchObject({ message: 'PAYOUT_ALREADY_REQUESTED' });
      expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID'); // 500 released back to custody, 1 of 2 winners paid

      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
      // what the cancel leaves behind: the released 500 is still held, so delete stays refused (runbook §7.4 note)
      await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
    });

    it('an approved winner left out because the pool was paid in full to another winner shows NONE and does not block COMPLETED', async () => {
      const { bountyId, rewardId } = await openBounty(2);
      const a = await winner(bountyId, 1);
      const b = await winner(bountyId, 2);
      await pay(rewardId, a.submissionId, '1000');
      expect((await rewardRow(rewardId)).status).toBe('PAID');
      await expect(rewards.requestPayout(rewardId, b.submissionId, '1', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
      expect(await shownStatus(b)).toEqual({ me: 'NONE', profile: ['NONE'] });

      await toInReview(bountyId);
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
    });

    it('still blocks while an approved winner is owed: headroom left and no payout, or a FAILED payout (operator must close it)', async () => {
      const { bountyId, rewardId } = await openBounty(2);
      const a = await winner(bountyId, 1);
      const b = await winner(bountyId, 2);
      await pay(rewardId, a.submissionId, '400');
      await toInReview(bountyId);

      // 600 headroom and B has no payout yet → B is owed
      expect(await shownStatus(b)).toEqual({ me: 'PENDING', profile: ['PENDING'] });
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID);

      // FAILED is terminal (not in flight) but still allocated and unpaid → B is still owed, still blocked
      const failed = await rewards.requestPayout(rewardId, b.submissionId, '600', adminId);
      await db.query(`UPDATE payout SET status = 'FAILED' WHERE id = $1`, [failed.id]);
      expect(await shownStatus(b)).toEqual({ me: 'PENDING', profile: ['PENDING'] });
      await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID);
      expect(await shownStatus(a)).toEqual({ me: 'PAID', profile: ['PAID'] });
    });

    /**
     * 적대적 검토 — payout 상태 집합을 한 곳(rewards/payout-status.ts)으로 모은 뒤에도 의도한 세 가지
     * (COMPLETED의 진행 중 payout 수, COMPLETED의 받을 몫 남은 승인 제출 수, 취소 ⇒ NONE) 밖의 규칙은 그대로인지 확인한다.
     */
    describe('adversarial: only the three intended rules moved', () => {
      /** runbook §7.4 취소 SQL의 FAILED 변형 — WHERE만 'FAILED'로 바꾼다 (온체인 미송금 확인 뒤, runbook 주석 참고) */
      async function cancelFailed(payoutId: string) {
        const r = await db.query(`UPDATE payout SET status = 'CANCELLED', last_error = 'never sent' WHERE id = $1 AND status = 'FAILED'`, [payoutId]);
        expect(r.rowCount).toBe(1);
      }
      /** scripts/record-refund.js의 runner 자리(pg Pool)에 DatabaseService.query를 넘긴다 — 같은 (text, params) 호출만 쓴다 */
      const asScriptRunner = () => ({ query: (text: string, params?: unknown[]) => db.query(text, params) }) as unknown as Parameters<typeof inspectReward>[0];
      const fail = (payoutId: string) => db.query(`UPDATE payout SET status = 'FAILED' WHERE id = $1`, [payoutId]);

      it('PAID + CANCELLED + FAILED + unrequested in one pool: statuses, reward status, blockers and the delete guard', async () => {
        const { bountyId, rewardId } = await openBounty(4);
        const a = await winner(bountyId, 1);
        const b = await winner(bountyId, 2);
        const c = await winner(bountyId, 3);
        const d = await winner(bountyId, 4);
        await pay(rewardId, a.submissionId, '300');
        const bPayout = await rewards.requestPayout(rewardId, b.submissionId, '300', adminId);
        const cPayout = await rewards.requestPayout(rewardId, c.submissionId, '300', adminId);
        await runbookCancel(bPayout.id);
        await fail(cPayout.id);
        // allocated = A 300 + C 300 (FAILED still holds its share) → 400 headroom; CANCELLED released B's 300
        await expect(rewards.requestPayout(rewardId, d.submissionId, '401', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
        expect(await shownStatus(a)).toEqual({ me: 'PAID', profile: ['PAID'] });
        expect(await shownStatus(b)).toEqual({ me: 'NONE', profile: ['NONE'] });
        expect(await shownStatus(c)).toEqual({ me: 'PENDING', profile: ['PENDING'] });
        expect(await shownStatus(d)).toEqual({ me: 'PENDING', profile: ['PENDING'] });

        // the two-person rule and the sendable/awaiting sets did not widen: terminal payouts cannot be approved or paid
        await expect(rewards.markApproved(cPayout.id, approverId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
        await expect(rewards.markApproved(bPayout.id, approverId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
        await expect(rewards.markPaid(cPayout.id, fakeTxHash(), adminId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
        const dPayout = await rewards.requestPayout(rewardId, d.submissionId, '400', adminId);
        await expect(rewards.markApproved(dPayout.id, adminId)).rejects.toMatchObject({ message: 'PAYOUT_SELF_APPROVAL' });
        await expect(rewards.markPaid(dPayout.id, fakeTxHash(), adminId)).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' }); // not approved yet
        await rewards.markApproved(dPayout.id, approverId);
        await rewards.markPaid(dPayout.id, fakeTxHash(), adminId);
        // FAILED is unsettled → reward stays PARTIALLY_PAID even though 2 PAID + the pool is allocated (same as before the refactor)
        expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID');
        expect(await shownStatus(d)).toEqual({ me: 'PAID', profile: ['PAID'] });

        await toInReview(bountyId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID); // C's FAILED payout
        // delete guard: FAILED is terminal (no open payout) but PAID 700 < cap 1000 → money still in custody → 409 (unchanged)
        await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });

        await cancelFailed(cPayout.id);
        expect(await shownStatus(c)).toEqual({ me: 'NONE', profile: ['NONE'] });
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
        await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' }); // 300 released, still held
      });

      it('a cancel that frees headroom makes an unrequested approved winner owed again (blocks until requested and paid)', async () => {
        const { bountyId, rewardId } = await openBounty(3);
        const a = await winner(bountyId, 1);
        const b = await winner(bountyId, 2);
        const c = await winner(bountyId, 3);
        await pay(rewardId, a.submissionId, '500');
        const bPayout = await rewards.requestPayout(rewardId, b.submissionId, '500', adminId);
        expect(await shownStatus(c)).toEqual({ me: 'NONE', profile: ['NONE'] }); // pool fully allocated
        await runbookCancel(bPayout.id);
        expect(await shownStatus(c)).toEqual({ me: 'PENDING', profile: ['PENDING'] }); // 500 released — C can now be requested
        await toInReview(bountyId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID);
        await pay(rewardId, c.submissionId, '500');
        expect((await rewardRow(rewardId)).status).toBe('PAID');
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
        await expect(bounties.remove(bountyId, adminId)).resolves.toBeDefined(); // everything paid out → delete allowed
      });

      it('a winner who withdrew their account while the pool was full does not block COMPLETED after a cancel frees headroom', async () => {
        const { bountyId, rewardId } = await openBounty(3);
        const a = await winner(bountyId, 1);
        const b = await winner(bountyId, 2);
        const gone = await winner(bountyId, 3);
        await pay(rewardId, a.submissionId, '500');
        const bPayout = await rewards.requestPayout(rewardId, b.submissionId, '500', adminId);
        // withdrawal is allowed now (no headroom → PENDING_REWARD_SQL is 0); simulate its effect on the rows requestPayout reads
        await db.query(`UPDATE "user" SET deleted_at = now(), status = 'WITHDRAWN' WHERE id = $1`, [gone.userId]);
        await db.query(`UPDATE wallet SET disconnected_at = now(), is_primary = false WHERE user_id = $1`, [gone.userId]);
        await runbookCancel(bPayout.id);
        // nobody can pay the withdrawn winner (requestPayout → 404), so they must not hold the bounty open forever
        await expect(rewards.requestPayout(rewardId, gone.submissionId, '500', adminId)).rejects.toMatchObject({ message: 'APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND' });
        await toInReview(bountyId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
      });

      it('two rewards on one bounty: owed is per reward (paid on one, headroom on the other → PARTIALLY_PAID, blocks)', async () => {
        const { bountyId, rewardId } = await openBounty(2);
        const second = await db.query<{ id: string }>(
          `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, deposit_tx_hash, custody_address, status)
           VALUES ($1, 'NATIVE', 'inj', 'INJ', 100, 100, $2, 'inj1testmultisig', 'FUNDED') RETURNING id`, [bountyId, fakeTxHash().toLowerCase()]);
        const r2 = second.rows[0].id;
        const a = await winner(bountyId, 1);
        const b = await winner(bountyId, 2);
        await pay(rewardId, a.submissionId, '500');
        await pay(rewardId, b.submissionId, '500');
        expect((await rewardRow(rewardId)).status).toBe('PAID');
        expect(await shownStatus(a)).toEqual({ me: 'PARTIALLY_PAID', profile: ['PARTIALLY_PAID'] });
        await toInReview(bountyId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID);

        await pay(r2, a.submissionId, '100'); // R2 exhausted by A
        expect(await shownStatus(a)).toEqual({ me: 'PAID', profile: ['PAID'] });
        expect(await shownStatus(b)).toEqual({ me: 'PAID', profile: ['PAID'] }); // R2 has no headroom left for B → not owed there
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
      });

      it('a second reward with a cancelled award: cancelled on R2 does not mask PAID on R1, and R1 open payouts still block', async () => {
        const { bountyId, rewardId } = await openBounty(1);
        const second = await db.query<{ id: string }>(
          `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, deposit_tx_hash, custody_address, status)
           VALUES ($1, 'NATIVE', 'inj', 'INJ', 100, 100, $2, 'inj1testmultisig', 'FUNDED') RETURNING id`, [bountyId, fakeTxHash().toLowerCase()]);
        const r2 = second.rows[0].id;
        const a = await winner(bountyId, 1);
        const r2Payout = await rewards.requestPayout(r2, a.submissionId, '100', adminId);
        const r1Payout = await rewards.requestPayout(rewardId, a.submissionId, '1000', adminId);
        await runbookCancel(r2Payout.id);
        expect(await shownStatus(a)).toEqual({ me: 'PENDING', profile: ['PENDING'] });
        await toInReview(bountyId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID); // R1 still REQUESTED
        await rewards.markApproved(r1Payout.id, approverId);
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject(UNPAID); // APPROVED is still open
        await rewards.markPaid(r1Payout.id, fakeTxHash(), adminId);
        expect(await shownStatus(a)).toEqual({ me: 'PAID', profile: ['PAID'] });
        await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
      });

      it('refund after a cancel: owed winners block CANCELLED until closed; then record-refund sees no open payout and refunds deposited minus PAID only', async () => {
        const { bountyId, rewardId } = await openBounty(3);
        const a = await winner(bountyId, 1);
        const b = await winner(bountyId, 2);
        const c = await winner(bountyId, 3);
        await pay(rewardId, a.submissionId, '400');
        const bPayout = await rewards.requestPayout(rewardId, b.submissionId, '300', adminId);
        const cPayout = await rewards.requestPayout(rewardId, c.submissionId, '300', adminId);
        // open payouts = winners still owed → the cancel (and with it the refund of their share) is refused (docs/decisions.md 2026-10-25)
        await expect(bounties.transition(bountyId, 'CANCELLED', adminId)).rejects.toMatchObject(UNPAID);
        const before = await inspectReward(asScriptRunner(), rewardId);
        expect(before.reward).toMatchObject({ bounty_status: 'OPEN', open_payouts: 2, paid_total: '400' });
        await runbookCancel(bPayout.id);
        await fail(cPayout.id);
        const failedOnly = await inspectReward(asScriptRunner(), rewardId);
        expect(failedOnly.reward).toMatchObject({ open_payouts: 0, paid_total: '400' }); // FAILED is terminal for the refund script…
        await expect(bounties.transition(bountyId, 'CANCELLED', adminId)).rejects.toMatchObject(UNPAID); // …but that winner is still owed
        // runbook §7.4 "FAILED payout": after confirming nothing went on chain, close it as CANCELLED
        expect((await db.query(`UPDATE payout SET status = 'CANCELLED' WHERE id = $1 AND status = 'FAILED'`, [cPayout.id])).rowCount).toBe(1);
        await expect(bounties.transition(bountyId, 'CANCELLED', adminId)).resolves.toEqual({ id: bountyId, status: 'CANCELLED' });
        const after = await inspectReward(asScriptRunner(), rewardId);
        expect(after.reward).toMatchObject({ bounty_status: 'CANCELLED', open_payouts: 0, paid_total: '400' });
        expect(after.refundedAmount).toBe('600');
        await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' }); // until REFUNDED is recorded
        await db.query(`UPDATE bounty_reward SET status = 'REFUNDED' WHERE id = $1`, [rewardId]);
        await expect(bounties.remove(bountyId, adminId)).resolves.toBeDefined();
      });
    });
  });

  describe('two transactions racing (each call takes its own pool client, so Promise.all is two real concurrent transactions)', () => {
    async function openBountyWithWinners(maxWinners: number, amount: string) {
      const { bountyId, rewardId } = await createFundedBounty({ maxWinners, amount });
      await rewards.confirmDeposit(rewardId, fakeTxHash(), amount, adminId);
      await bounties.transition(bountyId, 'OPEN', adminId);
      const winners: string[] = [];
      for (let i = 0; i < maxWinners; i++) winners.push(await approvedWinner(bountyId, i + 1));
      return { bountyId, rewardId, winners };
    }

    async function approvedPayout(rewardId: string, submissionId: string, amount: string) {
      const payout = await rewards.requestPayout(rewardId, submissionId, amount, adminId);
      await rewards.markApproved(payout.id, approverId);
      return payout.id;
    }

    const split = <T,>(results: PromiseSettledResult<T>[]) => ({
      fulfilled: results.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map((r) => r.value),
      rejected: results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error),
    });

    it('requestPayout twice for the same submission: one payout row, the loser gets 409 PAYOUT_ALREADY_REQUESTED (not a raw unique violation)', async () => {
      const { rewardId, winners: [submissionId] } = await openBountyWithWinners(1, '1000');
      const { fulfilled, rejected } = split(await Promise.allSettled([
        rewards.requestPayout(rewardId, submissionId, '400', adminId),
        rewards.requestPayout(rewardId, submissionId, '400', adminId),
      ]));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // the loser waited on the bounty/reward row locks, re-ran the duplicate check and saw the winner's row — it never reached uq_payout_idempotency
      expect(rejected[0]).toBeInstanceOf(ConflictException);
      expect(rejected[0].message).toBe('PAYOUT_ALREADY_REQUESTED');
      const rows = await db.query<{ id: string; amount: string }>(`SELECT id, amount::text FROM payout WHERE submission_id = $1`, [submissionId]);
      expect(rows.rows).toEqual([{ id: fulfilled[0].id, amount: '400' }]);
      expect(await auditActions(db, 'payout', fulfilled[0].id)).toEqual(['PAYOUT_REQUESTED']);
    });

    it('markPaid twice for the same payout (two different tx hashes): one PAID with the winning hash, one child NFT job, the loser gets 404 PAYOUT_NOT_FOUND_OR_WRONG_STATUS', async () => {
      const { rewardId, winners: [submissionId] } = await openBountyWithWinners(1, '1000');
      const payoutId = await approvedPayout(rewardId, submissionId, '1000');
      const hashes = [fakeTxHash(), fakeTxHash()];
      const { fulfilled, rejected } = split(await Promise.allSettled([
        rewards.markPaid(payoutId, hashes[0], adminId),
        rewards.markPaid(payoutId, hashes[1], adminId),
      ]));
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toBeInstanceOf(NotFoundException);
      expect(rejected[0].message).toBe('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
      const row = await db.query<{ status: string; payout_tx_hash: string }>(`SELECT status, payout_tx_hash FROM payout WHERE id = $1`, [payoutId]);
      expect(row.rows[0]).toEqual({ status: 'PAID', payout_tx_hash: fulfilled[0].payout_tx_hash });
      expect(hashes.map((h) => `0x${h.slice(2).toLowerCase()}`)).toContain(fulfilled[0].payout_tx_hash);
      const jobs = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nft_job WHERE idempotency_key = $1`, [`mint-child:${submissionId}`]);
      expect(jobs.rows[0].n).toBe(1);
      expect(await auditActions(db, 'payout', payoutId)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED', 'PAYOUT_PAID']);
      expect((await rewardRow(rewardId)).status).toBe('PAID');
    });

    /**
     * A RewardsService whose PAYOUT_PAID audit step parks the transaction of `payoutId` (everything before it — the PAID UPDATE,
     * the child NFT job, advanceRewardStatus — has run but is uncommitted) until `release` resolves. `parked` resolves on arrival.
     */
    function parkedMarkPaid(payoutId: string) {
      const parked = deferred<void>();
      const release = deferred<void>();
      const parkingAudit = {
        record: async (actor: string | undefined, action: string, type: string, id: string, runner?: unknown) => {
          if (action === 'PAYOUT_PAID' && id === payoutId) { parked.resolve(); await release.promise; }
          return new AuditService(db).record(actor, action as never, type as never, id, runner as never);
        },
      } as unknown as AuditService;
      return { service: new RewardsService(db, nfts, parkingAudit, testConfig()), parked: parked.promise, release: () => release.resolve() };
    }

    it('markPaid with the SAME hash on payouts of two different bounties while the first is still uncommitted: the advisory lock makes the second wait and then see the PAID row → 409 TX_HASH_ALREADY_USED', async () => {
      const first = await openBountyWithWinners(1, '1000');
      const second = await openBountyWithWinners(1, '1000');
      const payouts = [await approvedPayout(first.rewardId, first.winners[0], '1000'), await approvedPayout(second.rewardId, second.winners[0], '1000')];
      const hash = fakeTxHash();

      // T1 records the hash on bounty A and parks before committing. T2 then records the same hash on bounty B: it must block on the
      // per-hash advisory lock (T1's PAID row is invisible to it until T1 commits — without the lock T2's reuse check sees nothing and both commit).
      const { service: parkedService, parked, release } = parkedMarkPaid(payouts[0]);
      const t1 = parkedService.markPaid(payouts[0], hash, adminId);
      await parked;
      const t2 = rewards.markPaid(payouts[1], hash.toLowerCase(), adminId).then(() => 'paid' as const, (err: Error) => err);
      // either T2 is now waiting on the advisory lock (correct), or it already finished (lock missing) — release T1 in both cases and judge below
      await Promise.race([waitForLockWaiter(db, 'the second markPaid to block on the hash advisory lock'), t2]);
      release();

      await expect(t1).resolves.toMatchObject({ status: 'PAID' });
      const outcome = await t2;
      expect(outcome).toBeInstanceOf(ConflictException);
      expect((outcome as Error).message).toBe('TX_HASH_ALREADY_USED');
      const paid = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payout WHERE payout_tx_hash = $1 AND status = 'PAID'`, [`0x${hash.slice(2).toLowerCase()}`]);
      expect(paid.rows[0].n).toBe(1);
      expect((await db.query<{ status: string }>(`SELECT status FROM payout WHERE id = $1`, [payouts[1]])).rows[0].status).toBe('APPROVED'); // rolled back, can be paid with its own hash
    });

    it('markPaid of two winners overlapping inside advanceRewardStatus: the reward ends PAID — the reward FOR UPDATE makes the second recomputation see the first payout', async () => {
      const { rewardId, winners } = await openBountyWithWinners(2, '1000');
      const payouts = [await approvedPayout(rewardId, winners[0], '500'), await approvedPayout(rewardId, winners[1], '500')];

      // T1 pays the first winner and parks at its audit step: at that point T1 has already run advanceRewardStatus
      // (reward row locked, status PARTIALLY_PAID in its uncommitted view) and is holding everything open.
      const { service: parkedService, parked, release } = parkedMarkPaid(payouts[0]);
      const t1 = parkedService.markPaid(payouts[0], fakeTxHash(), adminId);
      await parked;

      // T2 pays the second winner: it must block on the reward row (SELECT … FOR UPDATE) until T1 commits, then recompute from a
      // fresh snapshot that includes T1's PAID payout. Without that lock T2's UPDATE would wait on the row inside the statement and
      // re-evaluate with its stale payout counts → PARTIALLY_PAID although both winners are paid.
      const t2 = rewards.markPaid(payouts[1], fakeTxHash(), adminId);
      await waitForLockWaiter(db, 'the second markPaid to block on the reward row held by the first');
      release();
      await expect(t1).resolves.toMatchObject({ status: 'PAID' });
      await expect(t2).resolves.toMatchObject({ status: 'PAID' });

      expect((await rewardRow(rewardId)).status).toBe('PAID');
      const paid = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payout WHERE bounty_reward_id = $1 AND status = 'PAID'`, [rewardId]);
      expect(paid.rows[0].n).toBe(2);
    });
  });
});
