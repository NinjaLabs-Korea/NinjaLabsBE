import { randomUUID } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser, fakeTxHash, testConfig, unique } from './harness';

/**
 * RewardsService 규칙을 실 Postgres로 고정한다 (예전에는 rewards.service.spec.ts가 SQL 문장을 해석하는 mock으로 흉내 냈다).
 * markPaid 해시 재사용 규칙, 지급 가능/불가 상태, 입금 확인과 지급 요청의 가드를 실제 행으로 확인한다.
 * 유닛 스펙에는 트랜잭션 전에 끝나는 검사(해시/금액 형식, 2인 승인 정책)만 남는다.
 */
describeDb('reward and payout rules on a real database', () => {
  let db: DatabaseService;
  let bounties: BountyAdminService;
  let rewards: RewardsService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let adminId: string;
  let approverId: string;

  beforeAll(async () => {
    db = createDb();
    const audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    rewards = new RewardsService(db, new NftsService(db, config), audit, config);
    submissions = new SubmissionsService(db);
    submissionReview = new SubmissionReviewService(db, audit);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  const normalized = (hash: string) => `0x${hash.slice(2).toLowerCase()}`;

  /** 입금 확인까지 끝나고 OPEN인 바운티 (보상 한 개) */
  async function openFunded(options: { amount?: string; deposit?: string; maxWinners?: number; submissionMode?: 'DIRECT' | 'AGENT' } = {}) {
    const amount = options.amount ?? '1000';
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('paid-rules-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode: options.submissionMode ?? 'DIRECT', maxWinners: options.maxWinners ?? 1,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount },
    });
    const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
    await rewards.confirmDeposit(rewardId, fakeTxHash(), options.deposit ?? amount, adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);
    return { bountyId, rewardId };
  }

  async function approvedWinner(bountyId: string) {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const submission = await submissions.submit(bountyId, userId, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
    await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    return { userId, walletId: wallet.id, submissionId: submission.id };
  }

  /** 승인(APPROVED)까지 끝난 payout 하나 */
  async function approvedPayout(rewardId: string, submissionId: string, amount = '100') {
    const payout = await rewards.requestPayout(rewardId, submissionId, amount, adminId);
    await rewards.markApproved(payout.id, approverId);
    return payout.id;
  }

  /** 새 바운티에 승인된 수상자 + APPROVED payout */
  async function readyPayout(options: { amount?: string; maxWinners?: number } = {}) {
    const funded = await openFunded(options);
    const winner = await approvedWinner(funded.bountyId);
    const payoutId = await approvedPayout(funded.rewardId, winner.submissionId, options.amount ?? '1000');
    return { ...funded, ...winner, payoutId };
  }

  const payoutRow = async (id: string) =>
    (await db.query<{ status: string; payout_tx_hash: string | null }>(`SELECT status, payout_tx_hash FROM payout WHERE id = $1`, [id])).rows[0];
  const childJobs = async (submissionId: string) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM nft_job WHERE idempotency_key = $1`, [`mint-child:${submissionId}`])).rows[0].n;

  describe('markPaid', () => {
    it('stores the hash as lowercase 0x, enqueues one child NFT job and audits PAYOUT_PAID in the same transaction', async () => {
      const { payoutId, submissionId } = await readyPayout();
      const hash = fakeTxHash();
      await expect(rewards.markPaid(payoutId, hash.slice(2), adminId)).resolves.toMatchObject({ status: 'PAID', payout_tx_hash: normalized(hash) });
      expect(await payoutRow(payoutId)).toEqual({ status: 'PAID', payout_tx_hash: normalized(hash) });
      expect(await childJobs(submissionId)).toBe(1);
      expect(await auditActions(db, 'payout', payoutId)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED', 'PAYOUT_PAID']);
    });

    it('pays a BROADCASTING payout as well as an APPROVED one', async () => {
      const { payoutId } = await readyPayout();
      await db.query(`UPDATE payout SET status = 'BROADCASTING' WHERE id = $1`, [payoutId]);
      await expect(rewards.markPaid(payoutId, fakeTxHash(), adminId)).resolves.toMatchObject({ status: 'PAID' });
    });

    it.each(['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'PAID', 'FAILED', 'CANCELLED'])(
      'refuses to pay a payout in status %s: 404 PAYOUT_NOT_FOUND_OR_WRONG_STATUS, nothing written (no hash, no NFT job, no PAYOUT_PAID)',
      async (status) => {
        const { payoutId, submissionId } = await readyPayout();
        await db.query(`UPDATE payout SET status = $2 WHERE id = $1`, [payoutId, status]);
        await expect(rewards.markPaid(payoutId, fakeTxHash(), adminId)).rejects.toMatchObject({ status: 404, message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
        expect(await payoutRow(payoutId)).toEqual({ status, payout_tx_hash: null });
        expect(await childJobs(submissionId)).toBe(0);
        expect(await auditActions(db, 'payout', payoutId)).not.toContain('PAYOUT_PAID');
      },
    );

    it('an unknown payout is 404 before hash reuse is looked at, even for a hash already paid on another bounty', async () => {
      const used = await readyPayout();
      const hash = fakeTxHash();
      await rewards.markPaid(used.payoutId, hash, adminId);
      await expect(rewards.markPaid(randomUUID(), hash, adminId)).rejects.toMatchObject({ status: 404, message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
    });

    it('a hash already PAID on a payout of a different bounty is 409 TX_HASH_ALREADY_USED and the payout stays unpaid', async () => {
      const first = await readyPayout();
      const second = await readyPayout();
      const hash = fakeTxHash();
      await rewards.markPaid(first.payoutId, hash, adminId);
      await expect(rewards.markPaid(second.payoutId, hash, adminId)).rejects.toMatchObject({ status: 409, message: 'TX_HASH_ALREADY_USED' });
      expect(await payoutRow(second.payoutId)).toEqual({ status: 'APPROVED', payout_tx_hash: null });
      expect(await childJobs(second.submissionId)).toBe(0);
      expect(await auditActions(db, 'payout', second.payoutId)).not.toContain('PAYOUT_PAID');
    });

    it('allows the same hash on several payouts of the same bounty (one multisig tx paying several winners) and logs it', async () => {
      const funded = await openFunded({ amount: '1000', maxWinners: 3 });
      const payouts: string[] = [];
      for (let i = 0; i < 3; i++) payouts.push(await approvedPayout(funded.rewardId, (await approvedWinner(funded.bountyId)).submissionId, '300'));
      const hash = fakeTxHash();
      const log = jest.spyOn(rewards['logger'], 'log').mockImplementation(() => undefined);
      try {
        await rewards.markPaid(payouts[0], hash, adminId);
        await rewards.markPaid(payouts[1], hash, adminId);
        await rewards.markPaid(payouts[2], hash, adminId);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('already recorded on 2 PAID payout(s) of the same bounty'));
      } finally {
        log.mockRestore();
      }
      const paid = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payout WHERE payout_tx_hash = $1 AND status = 'PAID'`, [normalized(hash)]);
      expect(paid.rows[0].n).toBe(3);
    });

    it('ignores payouts that merely carry the hash without being PAID, and PAID payouts with a different hash, on other bounties', async () => {
      const mine = await readyPayout();
      const notPaid = await readyPayout();
      const otherHash = await readyPayout();
      const hash = fakeTxHash();
      await db.query(`UPDATE payout SET payout_tx_hash = $2 WHERE id = $1`, [notPaid.payoutId, normalized(hash)]); // APPROVED, not PAID
      await rewards.markPaid(otherHash.payoutId, fakeTxHash(), adminId);
      const log = jest.spyOn(rewards['logger'], 'log').mockImplementation(() => undefined);
      try {
        await expect(rewards.markPaid(mine.payoutId, hash, adminId)).resolves.toMatchObject({ status: 'PAID' });
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    });

    it('a hash recorded as a reward deposit is 409 TX_HASH_ALREADY_USED (sponsor to multisig is never the winner payout)', async () => {
      const { payoutId, submissionId } = await readyPayout();
      const deposit = (await openFunded());
      const depositHash = (await db.query<{ deposit_tx_hash: string }>(`SELECT deposit_tx_hash FROM bounty_reward WHERE id = $1`, [deposit.rewardId])).rows[0].deposit_tx_hash;
      await expect(rewards.markPaid(payoutId, depositHash.toUpperCase().replace('0X', '0x'), adminId)).rejects.toMatchObject({ status: 409, message: 'TX_HASH_ALREADY_USED' });
      expect(await payoutRow(payoutId)).toEqual({ status: 'APPROVED', payout_tx_hash: null });
      expect(await childJobs(submissionId)).toBe(0);
    });

    it('a submission that is no longer APPROVED is 404 APPROVED_SUBMISSION_NOT_FOUND and the whole payment rolls back (no hash, NFT job or audit)', async () => {
      const { payoutId, submissionId } = await readyPayout();
      await db.query(`UPDATE bounty_submission SET status = 'REJECTED' WHERE id = $1`, [submissionId]);
      await expect(rewards.markPaid(payoutId, fakeTxHash(), adminId)).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_NOT_FOUND' });
      expect(await payoutRow(payoutId)).toEqual({ status: 'APPROVED', payout_tx_hash: null });
      expect(await childJobs(submissionId)).toBe(0);
      expect(await auditActions(db, 'payout', payoutId)).not.toContain('PAYOUT_PAID');
    });

    it('recomputes bounty_reward.status in the same transaction: PARTIALLY_PAID until the pool or the winner count is exhausted, then PAID', async () => {
      const funded = await openFunded({ amount: '1000', maxWinners: 2 });
      const a = await approvedPayout(funded.rewardId, (await approvedWinner(funded.bountyId)).submissionId, '400');
      const b = await approvedPayout(funded.rewardId, (await approvedWinner(funded.bountyId)).submissionId, '600');
      const status = async () => (await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [funded.rewardId])).rows[0].status;
      expect(await status()).toBe('FUNDED'); // nothing paid yet: no movement
      await rewards.markPaid(a, fakeTxHash(), adminId);
      expect(await status()).toBe('PARTIALLY_PAID');
      await rewards.markPaid(b, fakeTxHash(), adminId);
      expect(await status()).toBe('PAID');
    });
  });

  describe('confirmDeposit', () => {
    it('a hash already recorded as a payout is 409 TX_HASH_ALREADY_USED: the reward stays DEPOSIT_PENDING and nothing is audited', async () => {
      const { payoutId } = await readyPayout();
      const hash = fakeTxHash();
      await rewards.markPaid(payoutId, hash, adminId);
      const { id: bountyId } = await bounties.create(adminId, {
        title: unique('deposit-rules-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 1,
        submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '10' },
      });
      const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
      await expect(rewards.confirmDeposit(rewardId, hash, '10', adminId)).rejects.toMatchObject({ status: 409, message: 'TX_HASH_ALREADY_USED' });
      expect((await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].status).toBe('DEPOSIT_PENDING');
      expect(await auditActions(db, 'bounty_reward', rewardId)).toEqual([]);
    });

    it('a reward of a soft-deleted bounty takes no deposit: 404 REWARD_NOT_FOUND_OR_NOT_PENDING', async () => {
      const { id: bountyId } = await bounties.create(adminId, {
        title: unique('deposit-deleted-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
        category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners: 1,
        submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '10' },
      });
      const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
      await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [bountyId]);
      await expect(rewards.confirmDeposit(rewardId, fakeTxHash(), '10', adminId)).rejects.toMatchObject({ status: 404, message: 'REWARD_NOT_FOUND_OR_NOT_PENDING' });
      expect(await auditActions(db, 'bounty_reward', rewardId)).toEqual([]);
    });
  });

  describe('markApproved', () => {
    it('an unknown payout, or one that already left the approvable states, is 404 PAYOUT_NOT_FOUND_OR_WRONG_STATUS and not audited', async () => {
      const { payoutId } = await readyPayout();
      await expect(rewards.markApproved(randomUUID(), approverId)).rejects.toMatchObject({ status: 404, message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
      await expect(rewards.markApproved(payoutId, approverId)).rejects.toMatchObject({ status: 404, message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' }); // already APPROVED
      expect(await auditActions(db, 'payout', payoutId)).toEqual(['PAYOUT_REQUESTED', 'PAYOUT_APPROVED']);
    });

    it('the 404 comes before the self-approval check (an unknown payout never reveals a 403)', async () => {
      await expect(rewards.markApproved(randomUUID(), adminId)).rejects.toMatchObject({ status: 404, message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
    });
  });

  describe('requestPayout', () => {
    it('an unknown reward is 404 REWARD_NOT_FOUND', async () => {
      await expect(rewards.requestPayout(randomUUID(), randomUUID(), '1', adminId)).rejects.toMatchObject({ status: 404, message: 'REWARD_NOT_FOUND' });
    });

    it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('on a %s bounty it is 400 BOUNTY_REVIEW_CLOSED before the reward is read', async (status) => {
      const { bountyId, rewardId } = await openFunded();
      const winner = await approvedWinner(bountyId);
      await db.query(`UPDATE bounty SET status = $2 WHERE id = $1`, [bountyId, status]);
      await expect(rewards.requestPayout(rewardId, winner.submissionId, '1', adminId)).rejects.toMatchObject({ status: 400, message: 'BOUNTY_REVIEW_CLOSED' });
    });

    it.each(['DEPOSIT_PENDING', 'REFUND_PENDING', 'REFUNDED', 'CANCELLED'])('against a %s reward it is 400 REWARD_NOT_FUNDED and no payout row is created', async (status) => {
      const { bountyId, rewardId } = await openFunded();
      const winner = await approvedWinner(bountyId);
      await db.query(`UPDATE bounty_reward SET status = $2 WHERE id = $1`, [rewardId, status]);
      await expect(rewards.requestPayout(rewardId, winner.submissionId, '1', adminId)).rejects.toMatchObject({ status: 400, message: 'REWARD_NOT_FUNDED' });
      expect((await db.query(`SELECT 1 FROM payout WHERE submission_id = $1`, [winner.submissionId])).rowCount).toBe(0);
    });

    it('pays the primary, connected wallet of the submitter and stores a per-(submission, reward) idempotency key', async () => {
      const { bountyId, rewardId } = await openFunded();
      const winner = await approvedWinner(bountyId);
      // a secondary wallet and a disconnected old primary (the unique primary index only covers connected rows) must not be picked
      await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, false, now())`, [winner.userId, `inj1${unique()}`]);
      await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at, disconnected_at) VALUES ($1, 'INJECTIVE', $2, true, now(), now())`, [winner.userId, `inj1${unique()}`]);
      const payout = await rewards.requestPayout(rewardId, winner.submissionId, '100', adminId);
      const row = await db.query<{ recipient_wallet_id: string; idempotency_key: string; amount: string }>(
        `SELECT recipient_wallet_id, idempotency_key, amount::text FROM payout WHERE id = $1`, [payout.id]);
      expect(row.rows[0]).toEqual({ recipient_wallet_id: winner.walletId, idempotency_key: `submission:${winner.submissionId}:reward:${rewardId}`, amount: '100' });
    });

    it('an agent submission pays the primary, connected wallet of the agent owner', async () => {
      const { bountyId, rewardId } = await openFunded({ submissionMode: 'AGENT' });
      const ownerId = await createUser(db);
      const wallet = await createPrimaryWallet(db, ownerId);
      const agentId = (await db.query<{ id: string }>(
        `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at)
         VALUES ($1, 'payout-bot', $2, $3, 'ACTIVE', now()) RETURNING id`,
        [ownerId, unique('pk-'), `0x${unique()}`])).rows[0].id;
      const submission = await submissions.submitAsAgent(bountyId, agentId, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
      await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
      const payout = await rewards.requestPayout(rewardId, submission.id, '100', adminId);
      const row = await db.query<{ recipient_wallet_id: string }>(`SELECT recipient_wallet_id FROM payout WHERE id = $1`, [payout.id]);
      expect(row.rows[0].recipient_wallet_id).toBe(wallet.id);
    });

    it('a reward of a soft-deleted bounty takes no payout request: 404 REWARD_NOT_FOUND and no payout row', async () => {
      const { bountyId, rewardId } = await openFunded();
      const winner = await approvedWinner(bountyId);
      await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [bountyId]);
      await expect(rewards.requestPayout(rewardId, winner.submissionId, '100', adminId)).rejects.toMatchObject({ status: 404, message: 'REWARD_NOT_FOUND' });
      expect((await db.query(`SELECT 1 FROM payout WHERE submission_id = $1`, [winner.submissionId])).rowCount).toBe(0);
    });

    it('a submitter whose primary wallet is disconnected has no recipient: 404 APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND', async () => {
      const { bountyId, rewardId } = await openFunded();
      const winner = await approvedWinner(bountyId);
      await db.query(`UPDATE wallet SET disconnected_at = now() WHERE id = $1`, [winner.walletId]);
      await expect(rewards.requestPayout(rewardId, winner.submissionId, '100', adminId)).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND' });
    });

    it('the allocation check is exact at the cap with 78-digit amounts (no float rounding)', async () => {
      const cap = '9'.repeat(78);
      const almost = `${'9'.repeat(77)}8`;
      const { bountyId, rewardId } = await openFunded({ amount: '1000', maxWinners: 2 });
      await db.query(`UPDATE bounty_reward SET amount = $2::numeric, deposited_amount = $2::numeric WHERE id = $1`, [rewardId, cap]);
      const first = await approvedWinner(bountyId);
      const second = await approvedWinner(bountyId);
      // request amounts are capped at 30 digits (TOKEN_AMOUNT), so the 78-digit allocation is written directly
      await db.query(
        `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by)
         VALUES ($1, $2, $3, $4::numeric, $5, $6)`,
        [rewardId, first.submissionId, first.walletId, almost, `submission:${first.submissionId}:reward:${rewardId}`, adminId]);
      await expect(rewards.requestPayout(rewardId, second.submissionId, '2', adminId)).rejects.toMatchObject({ message: 'PAYOUT_EXCEEDS_AVAILABLE_REWARD' });
      await expect(rewards.requestPayout(rewardId, second.submissionId, '1', adminId)).resolves.toMatchObject({ status: 'REQUESTED' });
    });
  });
});
