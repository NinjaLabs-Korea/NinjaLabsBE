import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { RewardsService } from './rewards.service';

describe('RewardsService NFT linkage', () => {
  it('enqueues a completion NFT in the same transaction when a payout is paid', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 'payout', status: 'PAID', payout_tx_hash: '0xtx',
          submission_id: 'submission', recipient_wallet_id: 'wallet',
        }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: 'user', bounty_id: 'bounty' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
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

    await expect(service.markPaid('payout', '0xtx', 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(nfts.enqueueChildMintInTransaction).toHaveBeenCalledWith(
      tx, 'user', 'wallet', 'bounty', 'submission',
    );
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
