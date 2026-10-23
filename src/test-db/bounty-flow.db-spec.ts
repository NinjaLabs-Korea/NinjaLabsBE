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
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';

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

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    nfts = new NftsService(db, config);
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, nfts, audit);
    applications = new ApplicationsService(db);
    applicationReview = new ApplicationReviewService(db, audit);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onModuleDestroy());

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
    await expect(rewards.confirmDeposit(rewardId, depositHash, '999', adminId)).rejects.toMatchObject({ message: 'REWARD_NOT_FOUND_OR_NOT_PENDING' }); // short deposit
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
    await expect(rewards.markApproved(payout.id, adminId)).resolves.toEqual({ id: payout.id, status: 'APPROVED' });

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
    await rewards.markApproved(payout2.id, adminId);
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
    await rewards.markApproved(first.id, adminId);
    await rewards.markPaid(first.id, multiSendHash, adminId);
    expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID');

    await expect(rewards.requestPayout(rewardId, winners[1].submissionId, '601', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    const second = await rewards.requestPayout(rewardId, winners[1].submissionId, '600', adminId);
    await rewards.markApproved(second.id, adminId);
    await expect(rewards.markPaid(second.id, multiSendHash.toLowerCase(), adminId)).resolves.toMatchObject({ id: second.id, status: 'PAID' });
    expect((await rewardRow(rewardId)).status).toBe('PAID');
    const paidHashes = await db.query<{ payout_tx_hash: string }>(`SELECT payout_tx_hash FROM payout WHERE bounty_reward_id = $1 AND status = 'PAID'`, [rewardId]);
    expect(paidHashes.rows.map((row) => row.payout_tx_hash)).toEqual([`0x${multiSendHash.slice(2).toLowerCase()}`, `0x${multiSendHash.slice(2).toLowerCase()}`]);

    const childJobs = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nft_job j JOIN nft n ON n.id = j.nft_id WHERE n.bounty_id = $1 AND j.job_type = 'MINT_CHILD'`, [bountyId]);
    expect(childJobs.rows[0].n).toBe(2);
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
    await rewards.markApproved(first.id, adminId);
    await rewards.markPaid(first.id, fakeTxHash(), adminId);
    expect((await rewardRow(rewardId)).status).toBe('PAID'); // 1 winner paid of max_winners 1, even though 600 is left

    // the admin decides on a second winner: raise maxWinners, approve another submission
    await bounties.update(bountyId, { maxWinners: 2 }, adminId);
    const secondSubmission = await approvedWinner(bountyId, 2);

    await expect(rewards.requestPayout(rewardId, secondSubmission, '601', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    const second = await rewards.requestPayout(rewardId, secondSubmission, '600', adminId);
    expect(second.status).toBe('REQUESTED');
    expect((await rewardRow(rewardId)).status).toBe('PARTIALLY_PAID'); // back from PAID: a payout is open again

    await rewards.markApproved(second.id, adminId);
    await rewards.markPaid(second.id, fakeTxHash(), adminId);
    expect((await rewardRow(rewardId)).status).toBe('PAID');

    // pool exhausted: a third winner cannot be paid even if maxWinners were raised again
    await bounties.update(bountyId, { maxWinners: 3 }, adminId);
    const thirdSubmission = await approvedWinner(bountyId, 3);
    await expect(rewards.requestPayout(rewardId, thirdSubmission, '1', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
    expect((await rewardRow(rewardId)).status).toBe('PAID');
  });
});
