import { Pool } from 'pg';
import { run as forfeitAward } from '../../scripts/forfeit-award';
import { run as recordRefund } from '../../scripts/record-refund';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { SubmissionsService } from '../bounties/submissions/submissions.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, fakeTxHash, TEST_DB_URL_ENV, testConfig, unique, waitForLockWaiter } from './harness';

jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

/**
 * 2026-10-25 삭제 가드(입금액 전체) · record-refund(PAID 포함) · scripts/forfeit-award.js의 교차 검증 —
 * 다중 보상, 몰수 뒤 지갑 연결, 에이전트 제출, 동시 실행(바운티 행 잠금 직렬화)에서 돈/상태 규칙이 깨지지 않는지.
 */
describeDb('refund / delete / forfeit across rules and races', () => {
  const db = createDb();
  const config = testConfig();
  const audit = new AuditService(db);
  const bounties = new BountyAdminService(db, audit, new BountyLifecycleService(), new RewardTokenResolver(config));
  const rewards = new RewardsService(db, new NftsService(db, config), audit, config);
  const subs = new SubmissionsService(db);
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: process.env[TEST_DB_URL_ENV], max: 4 }); });
  afterAll(async () => { await pool.end(); await db.onApplicationShutdown(); });

  const run = async (script: typeof recordRefund, argv: string[]) => {
    const lines: string[] = [];
    const code = await script(argv, { pool, log: (l) => lines.push(l), prompt: async () => true });
    return { code, out: lines.join('\n') };
  };

  async function seed(maxWinners: number, rewardsSpec: Array<{ amount: number; deposited: number; denom?: string }>, status = 'IN_REVIEW') {
    const adminId = await createUser(db, { isAdmin: true });
    const admin2 = await createUser(db, { isAdmin: true });
    const b = await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
       VALUES ($1, 's', 'adv', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', $2, $3) RETURNING id`, [adminId, maxWinners, status]);
    const rewardIds: string[] = [];
    for (const r of rewardsSpec) {
      rewardIds.push((await db.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
         VALUES ($1, 'NATIVE', $2, 'T', $3, $4, $5, 'FUNDED') RETURNING id`,
        [b.rows[0].id, r.denom ?? 'inj', r.amount, r.deposited, `inj1${'q'.repeat(38)}`])).rows[0].id);
    }
    return { bountyId: b.rows[0].id, rewardIds, adminId, admin2 };
  }
  async function winner(bountyId: string, opts: { wallet?: boolean; agent?: boolean } = {}) {
    const userId = await createUser(db);
    if (opts.wallet !== false) await createPrimaryWallet(db, userId);
    let agentId: string | null = null;
    if (opts.agent) {
      agentId = (await db.query<{ id: string }>(
        `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status) VALUES ($1, 'a', $2, $3, 'ACTIVE') RETURNING id`,
        [userId, unique('pk-'), unique('aw-')])).rows[0].id;
    }
    const sid = (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, agent_id, submission_url, description, status)
       VALUES ($1, $2, $3, 'https://example.test/s', 'd', 'APPROVED') RETURNING id`, [bountyId, agentId ? null : userId, agentId])).rows[0].id;
    await db.query(`INSERT INTO submission_revision (submission_id, revision_no, submission_url, description, created_by_user_id, created_by_agent_id)
                    VALUES ($1, 1, 'https://example.test/s', 'd', $2, $3)`, [sid, agentId ? null : userId, agentId]);
    return { userId, sid, agentId };
  }
  async function pay(rewardId: string, sid: string, amount: string, requester: string, approver: string) {
    const p = await rewards.requestPayout(rewardId, sid, amount, requester);
    await rewards.markApproved(p.id, approver);
    await rewards.markPaid(p.id, fakeTxHash(), approver);
  }
  const rewardStatus = async (id: string) => (await db.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [id])).rows[0].status;

  it('multi-reward: over-deposit on reward 1 + untouched reward 2 — delete 409 until both refunded', async () => {
    const { bountyId, rewardIds: [r1, r2], adminId, admin2 } = await seed(1, [{ amount: 100, deposited: 150 }, { amount: 500, deposited: 500, denom: 'peggy0xusdt' }]);
    const w = await winner(bountyId);
    await pay(r1, w.sid, '100', adminId, admin2);
    await pay(r2, w.sid, '400', adminId, admin2);
    expect(await rewardStatus(r1)).toBe('PAID');
    expect(await rewardStatus(r2)).toBe('PAID'); // maxWinners 1 reached
    await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ status: 409 });
    // IN_REVIEW → OPEN(재오픈) → CANCELLED — 수상자는 다 받았으므로 UNPAID_WINNERS가 없다
    await bounties.transition(bountyId, 'OPEN', adminId);
    await expect(bounties.transition(bountyId, 'CANCELLED', adminId)).resolves.toMatchObject({ status: 'CANCELLED' });
    const a = await run(recordRefund, [r1, '--tx', fakeTxHash(), '--yes']);
    expect(a.out).toContain('refundedAmount=50');
    await expect(bounties.remove(bountyId, adminId)).rejects.toMatchObject({ status: 409 });
    const b = await run(recordRefund, [r2, '--tx', fakeTxHash(), '--yes']);
    expect(b.out).toContain('refundedAmount=100');
    await expect(bounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
    // refund twice refused
    expect((await run(recordRefund, [r2, '--tx', fakeTxHash(), '--yes'])).code).toBe(1);
  });

  it('forfeit then wallet connect: no payout possible, COMPLETED stays unblocked, /submissions/me payment_status NONE (not PENDING)', async () => {
    const { bountyId, rewardIds: [r1], adminId } = await seed(1, [{ amount: 100, deposited: 100 }]);
    const w = await winner(bountyId, { wallet: false });
    expect((await run(forfeitAward, [w.sid, '--reason', 'gone', '--admin', adminId, '--yes'])).code).toBe(0);
    await createPrimaryWallet(db, w.userId);
    await expect(rewards.requestPayout(r1, w.sid, '100', adminId)).rejects.toMatchObject({ status: 404 });
    const mine = await subs.mySubmissions(w.userId);
    expect(mine[0]).toMatchObject({ status: 'REJECTED', review_comment: 'forfeited: gone' });
    expect(mine[0].payment_status).toBe('NONE');
    await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('forfeit on an agent-owned submission unblocks COMPLETED; the owner sees REJECTED / NONE', async () => {
    const { bountyId, rewardIds: [r1], adminId } = await seed(1, [{ amount: 100, deposited: 100 }]);
    const w = await winner(bountyId, { wallet: false, agent: true });
    await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject({ status: 400 });
    const res = await run(forfeitAward, [w.sid, '--reason', 'agent owner unreachable', '--admin', adminId, '--yes']);
    expect(res.code).toBe(0);
    await createPrimaryWallet(db, w.userId);
    await expect(rewards.requestPayout(r1, w.sid, '100', adminId)).rejects.toMatchObject({ status: 404 });
    const mine = await subs.mySubmissions(w.userId);
    expect(mine[0]).toMatchObject({ status: 'REJECTED', payment_status: 'NONE' });
    await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('forfeit frees a slot: approve another, pay it, complete', async () => {
    const { bountyId, rewardIds: [r1], adminId, admin2 } = await seed(1, [{ amount: 100, deposited: 100 }]);
    const w = await winner(bountyId, { wallet: false });
    expect((await run(forfeitAward, [w.sid, '--reason', 'gone', '--admin', adminId, '--yes'])).code).toBe(0);
    const w2 = await winner(bountyId);
    await pay(r1, w2.sid, '100', adminId, admin2);
    expect(await rewardStatus(r1)).toBe('PAID');
    await expect(bounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toMatchObject({ status: 'COMPLETED' });
    await expect(bounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
  });

  for (let i = 0; i < 2; i += 1) {
    it(`forfeit vs concurrent requestPayout (round ${i}) — exactly one wins, no deadlock`, async () => {
      const { bountyId, rewardIds: [r1], adminId } = await seed(1, [{ amount: 100, deposited: 100 }]);
      const w = await winner(bountyId);
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM bounty WHERE id = $1 FOR UPDATE`, [bountyId]);
      const order = i % 2 === 0;
      const tasks: Promise<unknown>[] = [];
      const f = () => run(forfeitAward, [w.sid, '--reason', 'race', '--admin', adminId, '--yes']);
      const p = () => rewards.requestPayout(r1, w.sid, '100', adminId).then(() => 'payout', (e) => e.message);
      if (order) { tasks.push(f()); await waitForLockWaiter(db, 'first'); tasks.push(p()); }
      else { tasks.push(p()); await waitForLockWaiter(db, 'first'); tasks.push(f()); }
      await waitForLockWaiter(db, 'second', 2);
      await holder.query('COMMIT'); holder.release();
      const results = await Promise.all(tasks);
      const forfeitRes = (order ? results[0] : results[1]) as { code: number; out: string };
      const payoutRes = order ? results[1] : results[0];
      const payouts = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM payout WHERE submission_id = $1`, [w.sid])).rows[0].n;
      const st = (await db.query<{ status: string }>(`SELECT status FROM bounty_submission WHERE id = $1`, [w.sid])).rows[0].status;
      if (forfeitRes.code === 0) { expect(payouts).toBe(0); expect(st).toBe('REJECTED'); expect(payoutRes).toBe('APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND'); }
      else { expect(payouts).toBe(1); expect(st).toBe('APPROVED'); expect(payoutRes).toBe('payout'); expect(forfeitRes.out).toContain('payout row'); }
    });
  }

  for (let i = 0; i < 2; i += 1) {
    it(`record-refund vs concurrent delete (round ${i})`, async () => {
      const { bountyId, rewardIds: [r1], adminId, admin2 } = await seed(1, [{ amount: 100, deposited: 150 }]);
      const w = await winner(bountyId);
      await pay(r1, w.sid, '100', adminId, admin2);
      await db.query(`UPDATE bounty SET status = 'CANCELLED' WHERE id = $1`, [bountyId]);
      const holder = await pool.connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM bounty WHERE id = $1 FOR UPDATE`, [bountyId]);
      const order = i % 2 === 0;
      const tasks: Promise<unknown>[] = [];
      const rf = () => run(recordRefund, [r1, '--tx', fakeTxHash(), '--yes']);
      const del = () => bounties.remove(bountyId, adminId).then(() => 'deleted', (e) => String(e.status));
      if (order) { tasks.push(rf()); await waitForLockWaiter(db, 'first'); tasks.push(del()); }
      else { tasks.push(del()); await waitForLockWaiter(db, 'first'); tasks.push(rf()); }
      await waitForLockWaiter(db, 'second', 2);
      await holder.query('COMMIT'); holder.release();
      const results = await Promise.all(tasks);
      const refund = (order ? results[0] : results[1]) as { code: number };
      const deleted = order ? results[1] : results[0];
      expect(refund.code).toBe(0);
      expect(await rewardStatus(r1)).toBe('REFUNDED');
      expect(['deleted', '409']).toContain(deleted);
      if (deleted === 'deleted') {
        const t = await db.query<{ action: string; created_at: Date }>(
          `SELECT action, created_at FROM audit_log WHERE (entity_id = $1 AND action = 'BOUNTY_DELETED') OR (entity_id = $2 AND action = 'REWARD_REFUNDED') ORDER BY created_at`, [bountyId, r1]);
        expect(t.rows.map((r) => r.action)).toEqual(['REWARD_REFUNDED', 'BOUNTY_DELETED']);
      }
    });
  }
});
