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
    );

    await expect(service.markPaid('payout', '0xtx', 'admin')).resolves.toMatchObject({ status: 'PAID' });
    expect(nfts.enqueueChildMintInTransaction).toHaveBeenCalledWith(
      tx, 'user', 'wallet', 'bounty', 'submission',
    );
  });
});
