import { ConflictException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { RewardsService } from './rewards.service';

const txHash = `0x${'ab'.repeat(32)}`;

describe('RewardsService markPaid', () => {
  /** `reuse`: PAID payouts already carrying the same hash — on this payout's bounty / on other bounties */
  function setup(options: { reuse?: { same_bounty: number; other_bounty: number }; found?: boolean } = {}) {
    const query = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT rw.bounty_id FROM payout p')) {
        return options.found === false ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ bounty_id: 'bounty' }] };
      }
      if (sql.includes('AS other_bounty')) return { rowCount: 1, rows: [options.reuse ?? { same_bounty: 0, other_bounty: 0 }] };
      if (sql.includes(`UPDATE payout SET status = 'PAID'`)) {
        return {
          rowCount: 1,
          rows: [{
            id: 'payout', status: 'PAID', payout_tx_hash: txHash,
            submission_id: 'submission', recipient_wallet_id: 'wallet', bounty_reward_id: 'reward',
          }],
        };
      }
      if (sql.includes('FROM bounty_submission s')) return { rowCount: 1, rows: [{ owner_user_id: 'user', bounty_id: 'bounty' }] };
      return { rowCount: 1, rows: [] };
    }));
    const tx = { query };
    const db = {
      tx: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const nfts = {
      enqueueChildMintInTransaction: jest.fn().mockResolvedValue({ nftId: 'nft' }),
    };
    const service = new RewardsService(
      db as unknown as DatabaseService,
      nfts as unknown as NftsService,
      new AuditService(db as unknown as DatabaseService),
    );
    return { service, query, tx, nfts };
  }

  it('enqueues a completion NFT in the same transaction when a payout is paid', async () => {
    const { service, tx, nfts } = setup();
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(nfts.enqueueChildMintInTransaction).toHaveBeenCalledWith(
      tx, 'user', 'wallet', 'bounty', 'submission',
    );
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

  it('serializes on the hash, resolves the bounty of the payout, then looks for PAID payouts with the same hash — all before the UPDATE', async () => {
    const { service, query } = setup();
    await service.markPaid('payout', txHash, 'admin');
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const lock = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock(hashtext($1))'));
    const bounty = sqls.findIndex((sql) => sql.includes('SELECT rw.bounty_id FROM payout p'));
    const reuse = sqls.findIndex((sql) => sql.includes('AS other_bounty'));
    const update = sqls.findIndex((sql) => sql.includes(`UPDATE payout SET status = 'PAID'`));
    expect([lock, bounty, reuse, update]).toEqual([0, 1, 2, 3]);
    expect(query.mock.calls[lock][1]).toEqual([txHash]);
    expect(sqls[bounty]).toContain('FOR UPDATE OF p');
    expect(sqls[reuse]).toContain(`WHERE p.payout_tx_hash = $2 AND p.status = 'PAID' AND p.id <> $1`);
    expect(query.mock.calls[reuse][1]).toEqual(['payout', txHash, 'bounty']);
  });

  it('rejects with 409 TX_HASH_ALREADY_USED when the hash is already PAID on a payout of a different bounty, without touching the payout', async () => {
    const { service, query, nfts } = setup({ reuse: { same_bounty: 0, other_bounty: 1 } });
    const error = await service.markPaid('payout', txHash, 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('TX_HASH_ALREADY_USED');
    expect(query.mock.calls.some(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))).toBe(false);
    expect(nfts.enqueueChildMintInTransaction).not.toHaveBeenCalled();
  });

  it('allows the same hash on several payouts of the same bounty (one multisig tx paying several winners) and logs it', async () => {
    const { service, query } = setup({ reuse: { same_bounty: 2, other_bounty: 0 } });
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    await expect(service.markPaid('payout', txHash, 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes(`UPDATE payout SET status = 'PAID'`))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already recorded on 2 PAID payout(s) of the same bounty'));
  });

  it('reports PAYOUT_NOT_FOUND_OR_WRONG_STATUS for an unknown payout before looking at hash reuse', async () => {
    const { service, query } = setup({ found: false });
    await expect(service.markPaid('payout', txHash, 'admin')).rejects.toMatchObject({ message: 'PAYOUT_NOT_FOUND_OR_WRONG_STATUS' });
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('AS other_bounty'))).toBe(false);
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
    // Derived from current state (idempotent), only ever moves FUNDED/PARTIALLY_PAID forward.
    expect(sql).toContain("p.paid_count >= b.max_winners OR p.paid_amount >= rw.deposited_amount THEN 'PAID'");
    expect(sql).toContain("ELSE 'PARTIALLY_PAID'");
    expect(sql).toContain("WHERE bounty_reward_id = $1 AND status = 'PAID'");
    expect(sql).toContain("rw.status IN ('FUNDED', 'PARTIALLY_PAID')");
  });
});

describe('RewardsService confirmDeposit', () => {
  function setup(rowCount = 1) {
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: 'reward', bounty_id: 'bounty', status: 'FUNDED' }] : [] });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query })) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never));
    return { service, query, db };
  }

  it('confirms the deposit with the normalized tx hash and writes the audit row in the same transaction', async () => {
    const { service, query, db } = setup();
    await expect(service.confirmDeposit('reward', 'AB'.repeat(32), '1000000', 'admin')).resolves.toMatchObject({ status: 'FUNDED' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain("SET status = 'FUNDED'");
    expect(query.mock.calls[0][1]).toEqual(['reward', txHash, '1000000']);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1][1]).toEqual(['admin', 'REWARD_DEPOSIT_CONFIRMED', 'bounty_reward', 'reward']);
  });

  it('does not audit when the reward is not pending', async () => {
    const { service, query } = setup(0);
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toThrow('REWARD_NOT_FOUND_OR_NOT_PENDING');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['0xdeposit', 'ab'.repeat(31), `0x${'ab'.repeat(32)}0`, ''])('rejects tx hash %p with 400 INVALID_TX_HASH without touching the database', async (hash) => {
    const { service, db } = setup();
    await expect(service.confirmDeposit('reward', hash, '1000000', 'admin')).rejects.toMatchObject({ message: 'INVALID_TX_HASH' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('maps the uq_bounty_reward_deposit_tx unique violation to 409 TX_HASH_ALREADY_USED', async () => {
    const { service, query } = setup();
    query.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const error = await service.confirmDeposit('reward', txHash, '1000000', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('TX_HASH_ALREADY_USED');
  });
});

describe('RewardsService markApproved', () => {
  function setup(rowCount = 1) {
    const query = jest.fn().mockResolvedValue({ rowCount, rows: rowCount ? [{ id: 'payout', status: 'APPROVED' }] : [] });
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query })) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never));
    return { service, query, db };
  }

  it('approves the payout and audits inside the same transaction', async () => {
    const { service, query, db } = setup();
    await expect(service.markApproved('payout', 'admin')).resolves.toEqual({ id: 'payout', status: 'APPROVED' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain("SET status = 'APPROVED'");
    expect(query.mock.calls[0][1]).toEqual(['payout', 'admin']);
    expect(query.mock.calls[1][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[1][1]).toEqual(['admin', 'PAYOUT_APPROVED', 'payout', 'payout']);
  });

  it('does not audit when the payout is not in an approvable status', async () => {
    const { service, query } = setup(0);
    await expect(service.markApproved('payout', 'admin')).rejects.toThrow('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('RewardsService payout allocation', () => {
  function setup(options: { funded?: boolean; wallet?: boolean; duplicate?: boolean; allocated?: string } = {}) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'IN_REVIEW' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ bounty_id: 'bounty', status: options.funded === false ? 'DEPOSIT_PENDING' : 'FUNDED', deposited_amount: '10000000' }] })
      .mockResolvedValueOnce({ rowCount: options.wallet === false ? 0 : 1, rows: [{ wallet_id: 'wallet' }] })
      .mockResolvedValueOnce({ rowCount: options.duplicate ? 1 : 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ amount: options.allocated ?? '0' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'payout', status: 'REQUESTED' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const db = { tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query }) };
    const service = new RewardsService(db as never, {} as never, new AuditService(db as never));
    return { service, query };
  }
  it('creates a payout against the matching bounty and audits inside the transaction', async () => {
    const { service, query } = setup();
    await expect(service.requestPayout('reward', 'sub', '5000000', 'admin')).resolves.toMatchObject({ status: 'REQUESTED' });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[2]).toEqual([expect.stringContaining('s.bounty_id = $2'), ['sub', 'bounty']]);
    expect(query.mock.calls[6][0]).toContain('INSERT INTO audit_log');
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
