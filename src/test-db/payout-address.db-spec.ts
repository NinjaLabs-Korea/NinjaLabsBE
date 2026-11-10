import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AuditChange, AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, AuditAction } from '../audit/audit-actions';
import { AuthService } from '../auth/auth.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { BountyOperationsQuery } from '../bounties/admin/bounty-operations.query';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionReviewService } from '../bounties/submissions/submission-review.service';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { evmAddressOf, maskAddress, parsePayoutAddress } from '../common/validation/injective-address';
import { RewardsService } from '../rewards/rewards.service';
import { AccountWithdrawalService } from '../users/account-withdrawal.service';
import { describeDb } from './describe-db';
import {
  createDb, createPrimaryWallet, createUser, deferred, fakeTxHash, randomPayoutAddress, TEST_JWT_SECRET, testConfig, unique, waitForLockWaiter,
} from './harness';

/** 감사 기록 단계에서 트랜잭션을 세워 두는 AuditService - 경합 스펙에서 한쪽이 잠금을 쥔 채 커밋 전에 멈추게 한다 */
class ParkingAudit extends AuditService {
  readonly arrived = deferred();
  readonly release = deferred();
  constructor(db: DatabaseService, private readonly parkOn: AuditAction) { super(db); }
  async record<A extends AuditAction>(
    actorId: string | undefined, action: A, entityType: (typeof AUDIT_ACTIONS)[A], entityId: string, runner?: QueryRunner, change?: AuditChange,
  ): Promise<void> {
    await super.record(actorId, action, entityType, entityId, runner, change);
    if (action === this.parkOn) { this.arrived.resolve(); await this.release.promise; }
  }
}

/**
 * 2026-11-10 주소 기반 지급 (migration 0029): PUT /submissions/:id/payout-address(SubmissionsService.setPayoutAddress),
 * requestPayout의 주소 스냅샷, 탈퇴 시 주소 삭제, 운영 화면의 email·주소 필드, 0029 스키마 제약과 트리거를 실 Postgres로 본다.
 * 이 파일은 withPayoutAddresses 래퍼를 쓰지 않는다 (주소가 없을 때의 동작을 직접 본다).
 */
describeDb('payout address (0029) on a real database', () => {
  let db: DatabaseService;
  let audit: AuditService;
  let bounties: BountyAdminService;
  let submissions: SubmissionsService;
  let submissionReview: SubmissionReviewService;
  let rewards: RewardsService;
  let withdrawal: AccountWithdrawalService;
  let operations: BountyOperationsQuery;
  let adminId: string;
  let approverId: string;

  beforeAll(async () => {
    db = createDb();
    audit = new AuditService(db);
    const config = testConfig();
    bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
    submissions = new SubmissionsService(db, audit);
    submissionReview = new SubmissionReviewService(db, audit);
    rewards = new RewardsService(db, audit, config);
    const auth = new AuthService(db, new JwtService({ secret: TEST_JWT_SECRET, signOptions: { expiresIn: '15m' } }), config, TEST_JWT_SECRET);
    withdrawal = new AccountWithdrawalService(db, audit, auth);
    operations = new BountyOperationsQuery(db, new BountyLifecycleService(), config);
    adminId = await createUser(db, { isAdmin: true });
    approverId = await createUser(db, { isAdmin: true });
  });
  afterAll(async () => db.onApplicationShutdown());

  async function openFunded(maxWinners = 1) {
    const { id: bountyId } = await bounties.create(adminId, {
      title: unique('addr-'), sponsorName: 'Sponsor', summary: 's', description: 'd', requirements: 'r', evaluationCriteria: 'e',
      category: 'DEV', applicationRequired: false, submissionMode: 'DIRECT', maxWinners,
      submissionDeadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      reward: { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1000' },
    });
    const rewardId = (await db.query<{ id: string }>(`SELECT id FROM bounty_reward WHERE bounty_id = $1`, [bountyId])).rows[0].id;
    await rewards.confirmDeposit(rewardId, fakeTxHash(), '1000', adminId);
    await bounties.transition(bountyId, 'OPEN', adminId);
    return { bountyId, rewardId };
  }

  /** 제출 하나 (approve: true면 APPROVED까지) */
  async function entry(bountyId: string, options: { approve?: boolean; userId?: string } = {}) {
    const userId = options.userId ?? await createUser(db);
    const submission = await submissions.submit(bountyId, userId, { submissionUrl: `https://x.test/${unique()}`, description: 'd' });
    if (options.approve ?? true) await submissionReview.review(submission.id, 'APPROVE', undefined, adminId);
    return { userId, submissionId: submission.id };
  }

  const submissionRow = async (id: string) => (await db.query<{ payout_address: string | null; payout_address_updated_at: Date | null }>(
    `SELECT payout_address, payout_address_updated_at FROM bounty_submission WHERE id = $1`, [id])).rows[0];
  const addressAudits = async (submissionId: string) => (await db.query<{ actor_user_id: string; before_data: unknown; after_data: unknown }>(
    `SELECT actor_user_id, before_data, after_data FROM audit_log WHERE action = 'PAYOUT_ADDRESS_SET' AND entity_type = 'bounty_submission' AND entity_id = $1
      ORDER BY created_at`, [submissionId])).rows;
  const payoutsOf = async (submissionId: string) => (await db.query<{ id: string; recipient_address: string | null; recipient_wallet_id: string | null }>(
    `SELECT id, recipient_address, recipient_wallet_id FROM payout WHERE submission_id = $1`, [submissionId])).rows;

  describe('PUT /submissions/:id/payout-address (setPayoutAddress)', () => {
    it('only the submitter of a live bounty sees the submission: others, unknown ids and deleted bounties are 404 SUBMISSION_NOT_FOUND and nothing is written', async () => {
      const { bountyId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const stranger = await createUser(db);
      const address = randomPayoutAddress();
      await expect(submissions.setPayoutAddress(submissionId, stranger, address)).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
      await expect(submissions.setPayoutAddress(randomUUID(), userId, address)).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
      await db.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [bountyId]);
      await expect(submissions.setPayoutAddress(submissionId, userId, address)).rejects.toMatchObject({ status: 404, message: 'SUBMISSION_NOT_FOUND' });
      expect(await submissionRow(submissionId)).toEqual({ payout_address: null, payout_address_updated_at: null });
      expect(await addressAudits(submissionId)).toEqual([]);
    });

    it('takes APPROVED submissions only: a submission still under review or rejected is 409 SUBMISSION_NOT_APPROVED', async () => {
      const { bountyId } = await openFunded(2);
      const pending = await entry(bountyId, { approve: false });
      await expect(submissions.setPayoutAddress(pending.submissionId, pending.userId, randomPayoutAddress()))
        .rejects.toMatchObject({ status: 409, message: 'SUBMISSION_NOT_APPROVED' });
      const rejected = await entry(bountyId, { approve: false });
      await submissionReview.review(rejected.submissionId, 'REJECT', 'no', adminId);
      await expect(submissions.setPayoutAddress(rejected.submissionId, rejected.userId, randomPayoutAddress()))
        .rejects.toMatchObject({ status: 409, message: 'SUBMISSION_NOT_APPROVED' });
      expect(await submissionRow(pending.submissionId)).toEqual({ payout_address: null, payout_address_updated_at: null });
    });

    it('a malformed address is 400 INVALID_INJECTIVE_ADDRESS before any lock or write', async () => {
      const { bountyId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      for (const bad of ['', 'inj1notanaddress', `0x${'0'.repeat(40)}`, randomPayoutAddress().replace(/^inj1/, 'cosmos1')]) {
        await expect(submissions.setPayoutAddress(submissionId, userId, bad)).rejects.toMatchObject({ status: 400, message: 'INVALID_INJECTIVE_ADDRESS' });
      }
      expect(await submissionRow(submissionId)).toEqual({ payout_address: null, payout_address_updated_at: null });
    });

    it('sets (0x accepted, stored as lowercase inj1), is idempotent for the same account in either form (no audit, same timestamp), and audits each real change with masked addresses only', async () => {
      const { bountyId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const first = parsePayoutAddress(randomPayoutAddress());
      const set = await submissions.setPayoutAddress(submissionId, userId, first.evm.toLowerCase());
      expect(set).toEqual({ submissionId, payoutAddress: first.injective, payoutAddressEvm: first.evm, updatedAt: expect.any(Date) });
      expect(await submissionRow(submissionId)).toEqual({ payout_address: first.injective, payout_address_updated_at: set.updatedAt });

      const again = await submissions.setPayoutAddress(submissionId, userId, ` ${first.injective.toUpperCase()} `);
      expect(again).toEqual(set);
      expect(await addressAudits(submissionId)).toHaveLength(1);

      const second = parsePayoutAddress(randomPayoutAddress());
      const changed = await submissions.setPayoutAddress(submissionId, userId, second.injective);
      expect(changed.payoutAddress).toBe(second.injective);
      expect(await addressAudits(submissionId)).toEqual([
        { actor_user_id: userId, before_data: { address: null }, after_data: { address: maskAddress(first.injective) } },
        { actor_user_id: userId, before_data: { address: maskAddress(first.injective) }, after_data: { address: maskAddress(second.injective) } },
      ]);
      const raw = JSON.stringify((await db.query(`SELECT before_data, after_data FROM audit_log WHERE entity_id = $1`, [submissionId])).rows);
      for (const address of [first.injective, first.evm, first.evm.toLowerCase(), second.injective, second.evm]) expect(raw).not.toContain(address);
    });

    it('locks once a payout row exists (any status, even CANCELLED): 409 PAYOUT_ADDRESS_LOCKED, the address and the payout snapshot stay', async () => {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const { payoutAddress } = await submissions.setPayoutAddress(submissionId, userId, randomPayoutAddress());
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await expect(submissions.setPayoutAddress(submissionId, userId, randomPayoutAddress())).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ADDRESS_LOCKED' });
      await expect(submissions.setPayoutAddress(submissionId, userId, payoutAddress)).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ADDRESS_LOCKED' });
      await db.query(`UPDATE payout SET status = 'CANCELLED' WHERE id = $1`, [payout.id]);
      await expect(submissions.setPayoutAddress(submissionId, userId, randomPayoutAddress())).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ADDRESS_LOCKED' });
      expect((await submissionRow(submissionId)).payout_address).toBe(payoutAddress);
      expect(await payoutsOf(submissionId)).toEqual([{ id: payout.id, recipient_address: payoutAddress, recipient_wallet_id: null }]);
      expect(await addressAudits(submissionId)).toHaveLength(1);
    });
  });

  describe('requestPayout with payout addresses', () => {
    it('without an address: 409 PAYOUT_ADDRESS_NOT_SET and no side effects (no payout row, no audit, reward status unchanged) - a connected wallet is not a fallback', async () => {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      await createPrimaryWallet(db, userId);
      const rewardStatus = async () => (await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].status;
      const before = await rewardStatus();
      const audits = async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'PAYOUT_REQUESTED' AND after_data->>'submissionId' = $1`, [submissionId])).rows[0].n;
      await expect(rewards.requestPayout(rewardId, submissionId, '1000', adminId)).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ADDRESS_NOT_SET' });
      expect(await payoutsOf(submissionId)).toEqual([]);
      expect(await audits()).toBe(0);
      expect(await rewardStatus()).toBe(before);
    });

    it('a duplicate request is 409 PAYOUT_ALREADY_REQUESTED even for a legacy wallet payout whose submission has no address (duplicate check comes first)', async () => {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const wallet = await createPrimaryWallet(db, userId);
      await db.query(
        `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by) VALUES ($1, $2, $3, 1000, $4, $5)`,
        [rewardId, submissionId, wallet.id, `submission:${submissionId}:reward:${rewardId}`, adminId]);
      await expect(rewards.requestPayout(rewardId, submissionId, '1', adminId)).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ALREADY_REQUESTED' });
    });

    it('not approved, another bounty, or a withdrawn submitter: 404 APPROVED_SUBMISSION_NOT_FOUND', async () => {
      const { bountyId, rewardId } = await openFunded(2);
      const other = await openFunded();
      const pending = await entry(bountyId, { approve: false });
      await db.query(`UPDATE bounty_submission SET payout_address = $2, payout_address_updated_at = now() WHERE id = $1`, [pending.submissionId, randomPayoutAddress()]);
      await expect(rewards.requestPayout(rewardId, pending.submissionId, '1', adminId)).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_NOT_FOUND' });
      const elsewhere = await entry(other.bountyId);
      await submissions.setPayoutAddress(elsewhere.submissionId, elsewhere.userId, randomPayoutAddress());
      await expect(rewards.requestPayout(rewardId, elsewhere.submissionId, '1', adminId)).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_NOT_FOUND' });
      const gone = await entry(bountyId);
      await submissions.setPayoutAddress(gone.submissionId, gone.userId, randomPayoutAddress());
      await db.query(`UPDATE "user" SET deleted_at = now(), status = 'WITHDRAWN' WHERE id = $1`, [gone.userId]);
      await expect(rewards.requestPayout(rewardId, gone.submissionId, '1', adminId)).rejects.toMatchObject({ status: 404, message: 'APPROVED_SUBMISSION_NOT_FOUND' });
    });

    it('snapshots the address into payout.recipient_address (wallet id NULL); later submission edits (by hand) do not move the payout', async () => {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const { payoutAddress } = await submissions.setPayoutAddress(submissionId, userId, randomPayoutAddress());
      const payout = await rewards.requestPayout(rewardId, submissionId, '1000', adminId);
      await db.query(`UPDATE bounty_submission SET payout_address = $2 WHERE id = $1`, [submissionId, randomPayoutAddress()]);
      expect(await payoutsOf(submissionId)).toEqual([{ id: payout.id, recipient_address: payoutAddress, recipient_wallet_id: null }]);
      const requested = (await db.query<{ after_data: Record<string, unknown> }>(
        `SELECT after_data FROM audit_log WHERE action = 'PAYOUT_REQUESTED' AND entity_id = $1`, [payout.id])).rows[0].after_data;
      expect(requested).toMatchObject({ recipientAddress: maskAddress(payoutAddress), submissionId });
      expect(requested).not.toHaveProperty('recipientWalletId');
      expect(JSON.stringify(requested)).not.toContain(payoutAddress);
    });

    it.each(['address-first', 'request-first'])('a concurrent address change and payout request serialize on the submission row: %s', async (order) => {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      const original = (await submissions.setPayoutAddress(submissionId, userId, randomPayoutAddress())).payoutAddress;
      const next = randomPayoutAddress();
      const parking = new ParkingAudit(db, order === 'address-first' ? 'PAYOUT_ADDRESS_SET' : 'PAYOUT_REQUESTED');
      const parkedSubmissions = new SubmissionsService(db, parking);
      const parkedRewards = new RewardsService(db, parking, testConfig());
      const first = order === 'address-first'
        ? parkedSubmissions.setPayoutAddress(submissionId, userId, next)
        : parkedRewards.requestPayout(rewardId, submissionId, '1000', adminId);
      void first.catch(() => undefined);
      let second: Promise<unknown> | undefined;
      try {
        await parking.arrived.promise;
        second = order === 'address-first'
          ? rewards.requestPayout(rewardId, submissionId, '1000', adminId)
          : submissions.setPayoutAddress(submissionId, userId, next);
        void second.catch(() => undefined);
        await waitForLockWaiter(db, 'the competing request to wait on the submission row');
        parking.release.resolve();
        await first;
        if (order === 'address-first') {
          await second;
          expect((await payoutsOf(submissionId))[0].recipient_address).toBe(next); // re-read after the lock: the new address
        } else {
          await expect(second).rejects.toMatchObject({ status: 409, message: 'PAYOUT_ADDRESS_LOCKED' });
          expect((await payoutsOf(submissionId))[0].recipient_address).toBe(original);
          expect((await submissionRow(submissionId)).payout_address).toBe(original);
        }
      } finally {
        parking.release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
  });

  it('account withdrawal clears the payout addresses of the user\'s submissions in the same transaction and keeps payout snapshots', async () => {
    const paidBounty = await openFunded();
    const winner = await entry(paidBounty.bountyId);
    const { payoutAddress } = await submissions.setPayoutAddress(winner.submissionId, winner.userId, randomPayoutAddress());
    const payout = await rewards.requestPayout(paidBounty.rewardId, winner.submissionId, '1000', adminId);
    await rewards.markApproved(payout.id, approverId);
    await rewards.markPaid(payout.id, fakeTxHash(), adminId);
    // a second approved win with an address and no payout, on a bounty that is already closed (so it does not block the withdrawal)
    const closed = await openFunded();
    const second = await entry(closed.bountyId, { userId: winner.userId });
    await submissions.setPayoutAddress(second.submissionId, winner.userId, randomPayoutAddress());
    await db.query(`UPDATE bounty SET status = 'COMPLETED' WHERE id = $1`, [closed.bountyId]);
    const nickname = (await db.query<{ nickname: string }>(`SELECT nickname FROM "user" WHERE id = $1`, [winner.userId])).rows[0].nickname;

    await expect(withdrawal.withdraw(winner.userId, nickname)).resolves.toEqual({ ok: true });
    expect(await submissionRow(winner.submissionId)).toEqual({ payout_address: null, payout_address_updated_at: null });
    expect(await submissionRow(second.submissionId)).toEqual({ payout_address: null, payout_address_updated_at: null });
    expect(await payoutsOf(winner.submissionId)).toEqual([{ id: payout.id, recipient_address: payoutAddress, recipient_wallet_id: null }]);

    // the operations screen: the withdrawn winner's email is hidden; the payout still shows its snapshot (both forms)
    const ops = await operations.execute(paidBounty.bountyId, adminId);
    const sub = ops.submissions.find((s: { id: string }) => s.id === winner.submissionId);
    expect(sub).toMatchObject({ email: null, payout_address: null, payout_address_evm: null, recipient_wallet_address: null });
    expect(ops.payouts).toEqual([expect.objectContaining({ id: payout.id, recipient_address: payoutAddress, recipient_address_evm: evmAddressOf(payoutAddress) })]);
  });

  it('operations: email only for APPROVED submissions of live users, address fields in both forms, recipient_wallet_address alias, legacy wallet payouts show the wallet address', async () => {
    const { bountyId, rewardId } = await openFunded(3);
    const approved = await entry(bountyId);
    const pending = await entry(bountyId, { approve: false });
    const legacy = await entry(bountyId);
    const { payoutAddress, payoutAddressEvm, updatedAt } = await submissions.setPayoutAddress(approved.submissionId, approved.userId, randomPayoutAddress());
    const wallet = await createPrimaryWallet(db, legacy.userId);
    await db.query(
      `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by) VALUES ($1, $2, $3, 100, $4, $5)`,
      [rewardId, legacy.submissionId, wallet.id, `submission:${legacy.submissionId}:reward:${rewardId}`, adminId]);
    const emailOf = async (userId: string) => (await db.query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [userId])).rows[0].email;

    const ops = await operations.execute(bountyId, adminId);
    const byId = (id: string) => ops.submissions.find((s: { id: string }) => s.id === id);
    expect(byId(approved.submissionId)).toMatchObject({
      email: await emailOf(approved.userId), payout_address: payoutAddress, payout_address_evm: payoutAddressEvm,
      payout_address_updated_at: updatedAt, recipient_wallet_address: payoutAddress,
    });
    expect(byId(pending.submissionId)).toMatchObject({ email: null, payout_address: null, payout_address_evm: null, payout_address_updated_at: null });
    expect(byId(legacy.submissionId)).toMatchObject({ email: await emailOf(legacy.userId), payout_address: null, recipient_wallet_address: null });
    // the legacy row (recipient_wallet_id only) is still listed - LEFT JOIN wallet + COALESCE
    expect(ops.payouts).toEqual([expect.objectContaining({ submission_id: legacy.submissionId, recipient_address: wallet.address, recipient_address_evm: null })]);
  });

  it('/submissions/me carries the address fields and payout_address_editable (own APPROVED submission without a payout row)', async () => {
    const { bountyId, rewardId } = await openFunded(2);
    const userId = await createUser(db);
    const won = await entry(bountyId, { userId });
    const other = await openFunded();
    const pending = await entry(other.bountyId, { userId, approve: false });
    const mine = async () => Object.fromEntries((await submissions.mySubmissions(userId)).map((row) => [row.id, row]));

    let rows = await mine();
    expect(rows[won.submissionId]).toMatchObject({ payout_address: null, payout_address_evm: null, payout_address_updated_at: null, payout_address_editable: true });
    expect(rows[pending.submissionId]).toMatchObject({ payout_address: null, payout_address_editable: false });

    const set = await submissions.setPayoutAddress(won.submissionId, userId, randomPayoutAddress());
    rows = await mine();
    expect(rows[won.submissionId]).toMatchObject({
      payout_address: set.payoutAddress, payout_address_evm: set.payoutAddressEvm, payout_address_updated_at: set.updatedAt, payout_address_editable: true,
    });
    await rewards.requestPayout(rewardId, won.submissionId, '500', adminId);
    expect((await mine())[won.submissionId]).toMatchObject({ payout_address: set.payoutAddress, payout_address_editable: false });
  });

  describe('0029 schema', () => {
    async function seed() {
      const { bountyId, rewardId } = await openFunded();
      const { userId, submissionId } = await entry(bountyId);
      return { rewardId, userId, submissionId, key: `submission:${submissionId}:reward:${rewardId}` };
    }
    const insertPayout = (s: { rewardId: string; submissionId: string; key: string }, walletId: string | null, address: string | null) => db.query<{ recipient_wallet_id: string | null }>(
      `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, recipient_address, amount, idempotency_key, requested_by)
       VALUES ($1, $2, $3, $4, 10, $5, $6) RETURNING recipient_wallet_id`, [s.rewardId, s.submissionId, walletId, address, s.key, adminId]);

    it('a legacy INSERT with only recipient_wallet_id still works (old binaries keep writing)', async () => {
      const s = await seed();
      const wallet = await createPrimaryWallet(db, s.userId);
      await expect(insertPayout(s, wallet.id, null)).resolves.toMatchObject({ rows: [{ recipient_wallet_id: wallet.id }] });
    });

    it('a payout without any recipient is rejected (chk_payout_recipient, 23514)', async () => {
      const s = await seed();
      await expect(insertPayout(s, null, null)).rejects.toMatchObject({ code: '23514', constraint: 'chk_payout_recipient' });
    });

    it('an address-based payout for a user who replaced their wallet passes the 0026 trigger untouched (no wallet needed)', async () => {
      const s = await seed();
      await db.query(`UPDATE "user" SET receiving_wallet_revision = 1 WHERE id = $1`, [s.userId]); // replaced once, no connected primary wallet now
      const address = randomPayoutAddress();
      await expect(insertPayout(s, null, address)).resolves.toMatchObject({ rows: [{ recipient_wallet_id: null }] });
      // a legacy writer naming a wallet for the same user still goes through the 0026 body (no replacement wallet to redirect to)
      const legacy = await openFunded();
      const t = await entry(legacy.bountyId, { userId: s.userId });
      const w = await createPrimaryWallet(db, s.userId);
      await db.query(`UPDATE wallet SET disconnected_at = now(), is_primary = false WHERE id = $1`, [w.id]);
      await expect(insertPayout({ rewardId: legacy.rewardId, submissionId: t.submissionId, key: `submission:${t.submissionId}:reward:${legacy.rewardId}` }, w.id, null))
        .rejects.toMatchObject({ code: '23514', message: 'REPLACED_WALLET_RECIPIENT_UNAVAILABLE' });
    });

    it.each([
      ['uppercase', (a: string) => a.toUpperCase()],
      ['0x form', (a: string) => parsePayoutAddress(a).evm],
      ['32-byte contract shape', (a: string) => `${a}${'q'.repeat(20)}`],
      ['wrong charset', (a: string) => `${a.slice(0, -1)}b`],
    ])('rejects a non-canonical address (%s) on both columns (23514)', async (_label, mangle) => {
      const s = await seed();
      const bad = mangle(randomPayoutAddress());
      await expect(insertPayout(s, null, bad)).rejects.toMatchObject({ code: '23514', constraint: 'chk_payout_recipient_address' });
      await expect(db.query(`UPDATE bounty_submission SET payout_address = $2, payout_address_updated_at = now() WHERE id = $1`, [s.submissionId, bad]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_submission_payout_address' });
    });

    it('payout_address and payout_address_updated_at are set and cleared together (chk_submission_payout_address_stamp)', async () => {
      const s = await seed();
      await expect(db.query(`UPDATE bounty_submission SET payout_address = $2 WHERE id = $1`, [s.submissionId, randomPayoutAddress()]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_submission_payout_address_stamp' });
      await expect(db.query(`UPDATE bounty_submission SET payout_address_updated_at = now() WHERE id = $1`, [s.submissionId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'chk_submission_payout_address_stamp' });
    });

    it('re-running 0029 is safe (IF NOT EXISTS / DROP IF EXISTS / CREATE OR REPLACE), checked inside a rolled-back transaction', async () => {
      const sql = readFileSync(join(__dirname, '../../supabase/migrations/0029_payout_address.sql'), 'utf8');
      const done = new Error('rollback');
      await expect(db.tx(async (tx) => { await tx.query(sql); throw done; })).rejects.toBe(done);
    });

    it('the 0029 trigger function is the 0026 body plus only the early return for address-based payouts', () => {
      const read = (file: string) => readFileSync(join(__dirname, '../../supabase/migrations', file), 'utf8');
      const body = (sql: string) => {
        const start = sql.indexOf('FUNCTION protect_replaced_wallet_payout()');
        return sql.slice(sql.indexOf('$$', start) + 2, sql.indexOf('$$;', start));
      };
      const added = [
        '  -- 0029: address-based payouts (recipient_wallet_id NULL) are not tied to a wallet, so let them through.',
        '  -- Everything below is the 0026 body unchanged.',
        '  IF NEW.recipient_wallet_id IS NULL THEN RETURN NEW; END IF;',
      ];
      const stripped = body(read('0029_payout_address.sql')).split('\n').filter((line) => !added.includes(line)).join('\n');
      expect(stripped).toBe(body(read('0026_wallet_writer_compatibility.sql')));
      for (const line of added) expect(body(read('0029_payout_address.sql'))).toContain(line);
    });
  });
});
