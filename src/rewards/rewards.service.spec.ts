import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { RewardsService } from './rewards.service';

const txHash = `0x${'ab'.repeat(32)}`;
const config = (values: Record<string, string> = {}) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('RewardsService markPaid', () => {
  type PayoutRow = { id: string; bounty_id: string; payout_tx_hash: string | null; status: string };

  /**
   * Tiny in-memory payout table. The mock answers by the SHAPE of each statement (its predicates), never by which columns it
   * happens to select, so a regression in the SQL changes the answer:
   *   - the reuse lookup is evaluated from `others` with the WHERE filters and the `count(*) FILTER (WHERE rw.bounty_id = / <> $3)`
   *     predicates the statement actually carries — swap the two FILTERs or drop `p.status = 'PAID'` / `p.id <> $1` and the counts move;
   *   - the PAID UPDATE applies its own `status IN (...)` list to the target payout — drop the list and a REQUESTED payout is "paid".
   */
  function setup(options: { payout?: Partial<PayoutRow>; others?: PayoutRow[]; found?: boolean; deposits?: string[] } = {}) {
    const target: PayoutRow = { id: 'payout', bounty_id: 'bounty', payout_tx_hash: null, status: 'APPROVED', ...options.payout };
    const table = [target, ...(options.others ?? [])];
    const query = jest.fn(withParamsCheck(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT rw.bounty_id FROM payout p')) {
        return options.found === false || params![0] !== target.id ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ bounty_id: target.bounty_id }] };
      }
      if (sql.includes('FROM payout p JOIN bounty_reward rw') && sql.includes('count(*) FILTER')) {
        const [payoutId, hash, bountyId] = params as [string, string, string];
        const where = sql.slice(sql.lastIndexOf('WHERE'));
        const candidates = table.filter((p) =>
          (!where.includes('p.payout_tx_hash = $2') || p.payout_tx_hash === hash)
          && (!where.includes("p.status = 'PAID'") || p.status === 'PAID')
          && (!where.includes('p.id <> $1') || p.id !== payoutId));
        const row: Record<string, number> = {};
        for (const m of sql.matchAll(/count\(\*\) FILTER \(WHERE rw\.bounty_id (=|<>) \$3::uuid\)::int AS (\w+)/g)) {
          row[m[2]] = candidates.filter((p) => (m[1] === '=' ? p.bounty_id === bountyId : p.bounty_id !== bountyId)).length;
        }
        return { rowCount: 1, rows: [row] };
      }
      if (sql.includes(`UPDATE payout SET status = 'PAID'`)) {
        const allowed = /status IN \(([^)]*)\)/.exec(sql)?.[1].split(',').map((s) => s.trim().replace(/'/g, ''));
        if (params![0] !== target.id || (allowed && !allowed.includes(target.status))) return { rowCount: 0, rows: [] };
        target.status = 'PAID';
        target.payout_tx_hash = params![1] as string;
        return {
          rowCount: 1,
          rows: [{
            id: target.id, status: 'PAID', payout_tx_hash: target.payout_tx_hash,
            submission_id: 'submission', recipient_wallet_id: 'wallet', bounty_reward_id: 'reward',
          }],
        };
      }
      if (sql.includes('FROM bounty_submission s')) return { rowCount: 1, rows: [{ owner_user_id: 'user', bounty_id: target.bounty_id }] };
      if (sql.includes('FROM bounty_reward WHERE deposit_tx_hash = $1')) {
        const hit = (options.deposits ?? []).includes(params![0] as string);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{}] : [] };
      }
      return { rowCount: 1, rows: [] };
    }));
    const tx = { query };
    const db = {
      query: jest.fn(),
      tx: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const nfts = {
      enqueueChildMintInTransaction: jest.fn().mockResolvedValue({ nftId: 'nft' }),
    };
    const service = new RewardsService(
      db as unknown as DatabaseService,
      nfts as unknown as NftsService,
      new AuditService(db as unknown as DatabaseService),
      config(),
    );
    return { service, query, tx, db, nfts, target };
  }

  const paidElsewhere = (id: string, bounty_id: string, hash = txHash): PayoutRow => ({ id, bounty_id, payout_tx_hash: hash, status: 'PAID' });

  it('refuses a hash already recorded as a reward deposit (sponsor → multisig is never the winner payout) → 409 TX_HASH_ALREADY_USED before the UPDATE', async () => {
    const { service, query, nfts } = setup({ deposits: [txHash] });
    await expect(service.markPaid('payout', txHash.toUpperCase().replace('0X', '0x'), 'admin')).rejects.toMatchObject({ message: 'TX_HASH_ALREADY_USED' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))).toBe(false);
    expect(nfts.enqueueChildMintInTransaction).not.toHaveBeenCalled();
  });

  it('enqueues a completion NFT in the same transaction when a payout is paid', async () => {
    const { service, tx, db, nfts } = setup();
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(nfts.enqueueChildMintInTransaction).toHaveBeenCalledWith(
      tx, 'user', 'wallet', 'bounty', 'submission',
    );
    expect(db.query).not.toHaveBeenCalled();
  });

  it('normalizes the tx hash to lowercase 0x-prefixed before storing it', async () => {
    const { service, query } = setup();
    await service.markPaid('payout', 'AB'.repeat(32), 'admin');
    const update = query.mock.calls.find(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))!;
    expect(update[1]).toEqual(['payout', txHash]);
  });

  it('rejects a malformed tx hash with 400 INVALID_TX_HASH before opening a transaction', async () => {
    const { service, query } = setup();
    await expect(service.markPaid('payout', '0xtx', 'admin')).rejects.toMatchObject({ message: 'INVALID_TX_HASH' });
    expect(query).not.toHaveBeenCalled();
  });

  it('serializes on the hash, resolves the bounty of the payout, then looks for PAID payouts and deposits with the same hash — all before the UPDATE', async () => {
    const { service, query } = setup();
    await service.markPaid('payout', txHash, 'admin');
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const lock = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtext($1))'));
    const bounty = sqls.findIndex((sql) => sql.includes('SELECT rw.bounty_id FROM payout p'));
    const reuse = sqls.findIndex((sql) => sql.includes('count(*) FILTER'));
    const deposit = sqls.findIndex((sql) => sql.includes('FROM bounty_reward WHERE deposit_tx_hash = $1'));
    const update = sqls.findIndex((sql) => sql.includes(`UPDATE payout SET status = 'PAID'`));
    expect([lock, bounty, reuse, deposit, update]).toEqual([0, 1, 2, 3, 4]);
    expect(query.mock.calls[deposit][1]).toEqual([txHash]);
    expect(query.mock.calls[lock][1]).toEqual([txHash]);
    expect(sqls[bounty]).toContain('FOR UPDATE OF p');
    expect(sqls[reuse]).toContain(`WHERE p.payout_tx_hash = $2 AND p.status = 'PAID' AND p.id <> $1`);
    expect(query.mock.calls[reuse][1]).toEqual(['payout', txHash, 'bounty']);
  });

  it.each(['APPROVED', 'BROADCASTING'])('pays a payout in status %s', async (status) => {
    const { service } = setup({ payout: { status } });
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
  });

  it.each(['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'PAID', 'FAILED', 'CANCELLED'])(
    'refuses to pay a payout in status %s: the UPDATE matches no row → 404 PAYOUT_NOT_FOUND_OR_WRONG_STATUS, no NFT, no audit',
    async (status) => {
      const { service, query, nfts, target } = setup({ payout: { status } });
      const error = await service.markPaid('payout', txHash, 'admin').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
      expect(target.status).toBe(status);
      expect(nfts.enqueueChildMintInTransaction).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO audit_log'))).toBe(false);
    },
  );

  it('rejects with 409 TX_HASH_ALREADY_USED when the hash is already PAID on a payout of a different bounty, without touching the payout', async () => {
    const { service, query, nfts, target } = setup({ others: [paidElsewhere('other-payout', 'other-bounty')] });
    const error = await service.markPaid('payout', txHash, 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('TX_HASH_ALREADY_USED');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))).toBe(false);
    expect(target.status).toBe('APPROVED');
    expect(nfts.enqueueChildMintInTransaction).not.toHaveBeenCalled();
  });

  it('allows the same hash on several payouts of the same bounty (one multisig tx paying several winners) and logs it', async () => {
    const { service, query } = setup({ others: [paidElsewhere('p2', 'bounty'), paidElsewhere('p3', 'bounty')] });
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already recorded on 2 PAID payout(s) of the same bounty'));
  });

  it('ignores payouts that merely carry the hash without being PAID, and payouts with a different hash, on other bounties', async () => {
    const { service } = setup({
      others: [
        { id: 'approved-elsewhere', bounty_id: 'other-bounty', payout_tx_hash: txHash, status: 'APPROVED' },
        paidElsewhere('paid-other-hash', 'other-bounty', `0x${'cd'.repeat(32)}`),
      ],
    });
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(log).not.toHaveBeenCalled();
  });

  it('reports PAYOUT_NOT_FOUND_OR_WRONG_STATUS for an unknown payout before looking at hash reuse', async () => {
    const { service, query } = setup({ found: false });
    await expect(service.markPaid('payout', txHash, 'admin')).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('count(*) FILTER'))).toBe(false);
  });

  it('locks the reward and recomputes bounty_reward.status inside the same transaction', async () => {
    const { service, query } = setup();
    await service.markPaid('payout', txHash, 'admin');

    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const lock = sqls.findIndex((sql) => sql.includes('FROM bounty_reward WHERE id = $1 FOR UPDATE'));
    const recompute = sqls.findIndex((sql) => sql.includes('UPDATE bounty_reward rw'));
    const audit = sqls.findIndex((sql) => sql.includes('INSERT INTO audit_log'));
    expect(lock).toBeGreaterThan(0);
    expect(recompute).toBeGreaterThan(lock);
    expect(audit).toBeGreaterThan(recompute);
    expect(query.mock.calls[lock][1]).toEqual(['reward']);
    expect(query.mock.calls[recompute][1]).toEqual(['reward']);

    const sql = sqls[recompute];
    // Derived from current state (idempotent): PAID only when nothing is still open and the pool or the winner count is exhausted;
    // a PAID reward drops back to PARTIALLY_PAID once a new payout is requested; nothing moves before the first PAID payout.
    // the pool is the allocation cap LEAST(posted amount, deposit) — an over-deposit is not headroom (same cap as requestPayout)
    expect(sql).toContain("p.open_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= LEAST(rw.amount, rw.deposited_amount)) THEN 'PAID'");
    expect(sql).toContain("ELSE 'PARTIALLY_PAID'");
    expect(sql).toContain("count(*) FILTER (WHERE status NOT IN ('PAID', 'CANCELLED'))::int AS open_count");
    expect(sql).toContain("rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')");
    expect(sql).toContain('AND p.paid_count > 0');
  });
});

describe('RewardsService confirmDeposit', () => {
  /** SQL 모양으로 답한다 — 해시 잠금, payout 해시 조회(options.payoutHashes), 조건부 UPDATE(rowCount), 감사 INSERT */
  function setup(rowCount = 1, options: { payoutHashes?: string[]; bountyDeleted?: boolean } = {}) {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FROM payout WHERE payout_tx_hash = $1')) {
        const hit = (options.payoutHashes ?? []).includes(params![0] as string);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{}] : [] };
      }
      if (sql.includes('FROM bounty b JOIN bounty_reward rw')) return options.bountyDeleted ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 'bounty' }] };
      if (sql.includes("SET status = 'FUNDED'")) return { rowCount, rows: rowCount ? [{ id: 'reward', bounty_id: 'bounty', status: 'FUNDED' }] : [] };
      return { rowCount: 1, rows: [] };
    });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query: withParamsCheck(query) as unknown as jest.Mock })) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never), config());
    return { service, query, db };
  }
  const sqlIndex = (query: jest.Mock, fragment: string) => query.mock.calls.findIndex(([sql]) => (sql as string).includes(fragment));

  it('confirms the deposit with the normalized tx hash and writes the audit row in the same transaction', async () => {
    const { service, query, db } = setup();
    await expect(service.confirmDeposit('reward', 'AB'.repeat(32), '1000000', 'admin')).resolves.toMatchObject({ status: 'FUNDED' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    const lock = sqlIndex(query, 'pg_advisory_xact_lock');
    const payoutCheck = sqlIndex(query, 'FROM payout WHERE payout_tx_hash = $1');
    const bountyLock = sqlIndex(query, 'FROM bounty b JOIN bounty_reward rw');
    const update = sqlIndex(query, "SET status = 'FUNDED'");
    const audit = sqlIndex(query, 'INSERT INTO audit_log');
    expect([lock, payoutCheck, bountyLock, update, audit]).toEqual([0, 1, 2, 3, 4]);
    expect(query.mock.calls[bountyLock][0]).toContain('b.deleted_at IS NULL FOR UPDATE OF b');
    expect(query.mock.calls[bountyLock][1]).toEqual(['reward']);
    expect(query.mock.calls[lock][1]).toEqual([txHash]);
    expect(query.mock.calls[payoutCheck][1]).toEqual([txHash]);
    expect(query.mock.calls[update][1]).toEqual(['reward', txHash, '1000000']);
    expect(query.mock.calls[audit][1]).toEqual(['admin', 'REWARD_DEPOSIT_CONFIRMED', 'bounty_reward', 'reward']);
  });

  it('refuses a hash already recorded as a payout → 409 TX_HASH_ALREADY_USED, no UPDATE, no audit', async () => {
    const { service, query } = setup(1, { payoutHashes: [txHash] });
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toMatchObject({ message: 'TX_HASH_ALREADY_USED' });
    expect(sqlIndex(query, "SET status = 'FUNDED'")).toBe(-1);
    expect(sqlIndex(query, 'INSERT INTO audit_log')).toBe(-1);
  });

  it('locks the bounty row (serializes with DELETE /admin/bounties/:id) and refuses a reward of a deleted bounty → 404, no UPDATE', async () => {
    const { service, query } = setup(1, { bountyDeleted: true });
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toThrow('REWARD_NOT_FOUND_OR_NOT_PENDING');
    expect(sqlIndex(query, "SET status = 'FUNDED'")).toBe(-1);
    expect(sqlIndex(query, 'INSERT INTO audit_log')).toBe(-1);
  });

  it('does not audit when the reward is not pending', async () => {
    const { service, query } = setup(0);
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toThrow('REWARD_NOT_FOUND_OR_NOT_PENDING');
    expect(sqlIndex(query, 'INSERT INTO audit_log')).toBe(-1);
  });

  it.each(['0xdeposit', 'ab'.repeat(31), `0x${'ab'.repeat(32)}0`, ''])('rejects tx hash %p with 400 INVALID_TX_HASH without touching the database', async (hash) => {
    const { service, db } = setup();
    await expect(service.confirmDeposit('reward', hash, '1000000', 'admin')).rejects.toMatchObject({ message: 'INVALID_TX_HASH' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('maps the uq_bounty_reward_deposit_tx unique violation to 409 TX_HASH_ALREADY_USED', async () => {
    const { service, query } = setup();
    const answer = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET status = 'FUNDED'")) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return answer(sql, params);
    });
    const error = await service.confirmDeposit('reward', txHash, '1000000', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('TX_HASH_ALREADY_USED');
  });
});

describe('RewardsService markApproved (two-person rule)', () => {
  function setup(options: { found?: boolean; requestedBy?: string; allowSelf?: string } = {}) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith('SELECT requested_by FROM payout')) {
        return options.found === false ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ requested_by: options.requestedBy ?? 'requester' }] };
      }
      if (sql.includes("SET status = 'APPROVED'")) return { rowCount: 1, rows: [{ id: 'payout', status: 'APPROVED' }] };
      return { rowCount: 1, rows: [] };
    });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query: withParamsCheck(query) as unknown as jest.Mock })) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never),
      config(options.allowSelf === undefined ? {} : { PAYOUT_ALLOW_SELF_APPROVAL: options.allowSelf }));
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    return { service, query, db, warn };
  }

  it('a different admin approves: row locked, approved_by stored, PAYOUT_APPROVED audited in the same transaction', async () => {
    const { service, query, db, warn } = setup();
    await expect(service.markApproved('payout', 'approver')).resolves.toEqual({ id: 'payout', status: 'APPROVED' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain("status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL') FOR UPDATE");
    expect(query.mock.calls[1][0]).toContain("SET status = 'APPROVED', approved_by = $2");
    expect(query.mock.calls[1][1]).toEqual(['payout', 'approver']);
    expect(query.mock.calls[2][1]).toEqual(['approver', 'PAYOUT_APPROVED', 'payout', 'payout']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the requesting admin is refused with 403 PAYOUT_SELF_APPROVAL — no UPDATE, no audit', async () => {
    const { service, query } = setup({ requestedBy: 'admin' });
    await expect(service.markApproved('payout', 'admin')).rejects.toMatchObject({ status: 403, message: 'PAYOUT_SELF_APPROVAL' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['false', '', '1', 'yes'])('PAYOUT_ALLOW_SELF_APPROVAL=%p keeps the rule', async (allowSelf) => {
    const { service } = setup({ requestedBy: 'admin', allowSelf });
    await expect(service.markApproved('payout', 'admin')).rejects.toMatchObject({ message: 'PAYOUT_SELF_APPROVAL' });
  });

  it.each(['true', ' TRUE '])('PAYOUT_ALLOW_SELF_APPROVAL=%p (solo operator) allows it with a warn and audits PAYOUT_SELF_APPROVED instead of PAYOUT_APPROVED', async (allowSelf) => {
    const { service, query, warn } = setup({ requestedBy: 'admin', allowSelf });
    expect(warn).not.toHaveBeenCalled(); // the boot-time warn fired in the constructor, before the spy
    await expect(service.markApproved('payout', 'admin')).resolves.toEqual({ id: 'payout', status: 'APPROVED' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('approved by the admin who requested it'));
    expect(query.mock.calls[2][1]).toEqual(['admin', 'PAYOUT_SELF_APPROVED', 'payout', 'payout']);
  });

  it('404 PAYOUT_NOT_FOUND_OR_WRONG_STATUS for an unknown or non-approvable payout, before the self-approval check', async () => {
    const { service, query } = setup({ found: false, requestedBy: 'admin' });
    await expect(service.markApproved('payout', 'admin')).rejects.toThrow('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('RewardsService payout allocation', () => {
  function setup(options: { funded?: boolean; rewardStatus?: string; wallet?: boolean; duplicate?: boolean; allocated?: string } = {}) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'IN_REVIEW' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ bounty_id: 'bounty', status: options.funded === false ? 'DEPOSIT_PENDING' : options.rewardStatus ?? 'FUNDED', cap: '10000000' }] })
      .mockResolvedValueOnce({ rowCount: options.wallet === false ? 0 : 1, rows: [{ wallet_id: 'wallet' }] })
      .mockResolvedValueOnce({ rowCount: options.duplicate ? 1 : 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ amount: options.allocated ?? '0' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'payout', status: 'REQUESTED' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const db = { query: jest.fn(), tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query: withParamsCheck(query) }) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never), config());
    return { service, query, db };
  }
  it('caps the allocation at LEAST(posted amount, deposit): the reward is read as that cap, so an over-deposit does not raise it', async () => {
    const { service, query } = setup({ allocated: '5000000' });
    await expect(service.requestPayout('reward', 'sub', '5000001', 'admin')).rejects.toThrow('PAYOUT_EXCEEDS_AVAILABLE_REWARD');
    expect(query.mock.calls[1][0]).toContain('LEAST(amount, deposited_amount)::text AS cap FROM bounty_reward WHERE id = $1 FOR UPDATE');
    await expect(setup({ allocated: '5000000' }).service.requestPayout('reward', 'sub', '5000000', 'admin')).resolves.toMatchObject({ status: 'REQUESTED' });
  });
  it('creates a payout against the matching bounty, recomputes the reward status and audits inside the transaction', async () => {
    const { service, query, db } = setup();
    await expect(service.requestPayout('reward', 'sub', '5000000', 'admin')).resolves.toMatchObject({ status: 'REQUESTED' });
    expect(db.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[2]).toEqual([expect.stringContaining('s.bounty_id = $2'), ['sub', 'bounty']]);
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const insert = sqls.findIndex((sql) => sql.includes('INSERT INTO payout'));
    const recompute = sqls.findIndex((sql) => sql.includes('UPDATE bounty_reward rw'));
    const audit = sqls.findIndex((sql) => sql.includes('INSERT INTO audit_log'));
    expect(insert).toBeGreaterThan(0);
    expect(recompute).toBeGreaterThan(insert);
    expect(audit).toBeGreaterThan(recompute);
    expect(query.mock.calls[recompute][1]).toEqual(['reward']);
  });

  it('accepts a payout against a PAID reward while headroom remains (maxWinners raised after the first payout) and recomputes the status', async () => {
    const { service, query } = setup({ rewardStatus: 'PAID', allocated: '4000000' });
    await expect(service.requestPayout('reward', 'sub', '5000000', 'admin')).resolves.toMatchObject({ status: 'REQUESTED' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('UPDATE bounty_reward rw'))).toBe(true);
  });

  it('rejects a payout against a PAID reward with no headroom left', async () => {
    const { service, query } = setup({ rewardStatus: 'PAID', allocated: '10000000' });
    await expect(service.requestPayout('reward', 'sub', '1', 'admin')).rejects.toThrow('PAYOUT_EXCEEDS_AVAILABLE_REWARD');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('INSERT INTO payout'))).toBe(false);
  });
  it.each([
    [{ funded: false }, 'REWARD_NOT_FUNDED'],
    [{ wallet: false }, 'APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND'],
    [{ duplicate: true }, 'PAYOUT_ALREADY_REQUESTED'],
    [{ allocated: '9000000' }, 'PAYOUT_EXCEEDS_AVAILABLE_REWARD'],
  ] as const)('rejects invalid allocations: %s', async (options, error) => {
    await expect(setup(options).service.requestPayout('reward', 'sub', '5000000', 'admin')).rejects.toThrow(error);
  });
  it.each(['0', '-1', '1.5', '1e6', '9'.repeat(79)])('rejects invalid token units %s', async (amount) => {
    const { service, query } = setup();
    await expect(service.requestPayout('reward', 'sub', amount, 'admin')).rejects.toThrow('INVALID_TOKEN_AMOUNT');
    expect(query).not.toHaveBeenCalled();
  });
});
