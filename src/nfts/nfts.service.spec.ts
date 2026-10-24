import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { NftsService } from './nfts.service';

describe('NftsService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const walletId = '22222222-2222-4222-8222-222222222222';
  const bountyId = '33333333-3333-4333-8333-333333333333';
  const submissionId = '44444444-4444-4444-8444-444444444444';
  const parentNftId = '55555555-5555-4555-8555-555555555555';
  const newNftId = '66666666-6666-4666-8666-666666666666';

  function setup(options: { contract?: string; nftInserted?: boolean; parentExists?: boolean } = {}) {
    const txQuery = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes(`SELECT id FROM nft WHERE owner_user_id = $1 AND nft_type = 'NINJA_PARENT'`)) {
        return options.parentExists ? { rowCount: 1, rows: [{ id: parentNftId }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO nft (')) {
        return options.nftInserted === false ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: newNftId }] };
      }
      return { rowCount: 1, rows: [] };
    }));
    const query = jest.fn(withParamsCheck(async (_sql: string, _params?: unknown[]) => ({ rowCount: 2, rows: [{ id: 'a' }, { id: 'b' }] })));
    const db = {
      query,
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) => callback({ query: txQuery })),
    };
    const config = { get: jest.fn((key: string) => (key === 'NFT_CONTRACT_ADDRESS' ? options.contract : undefined)) };
    const service = new NftsService(db as unknown as DatabaseService, config as unknown as ConfigService);
    return { service, db, txQuery, query };
  }

  describe('enqueueParentMint', () => {
    it('creates the NINJA_PARENT nft and a MINT_PARENT job keyed per user, in one transaction', async () => {
      const { service, db, txQuery } = setup({ contract: 'inj1contract' });
      await expect(service.enqueueParentMint(userId, walletId)).resolves.toEqual({ nftId: newNftId });
      expect(db.tx).toHaveBeenCalledTimes(1);
      const [nftSql, nftParams] = txQuery.mock.calls[0];
      expect(nftSql).toContain(`'NINJA_PARENT'`);
      expect(nftSql).toContain('ON CONFLICT DO NOTHING');
      expect(nftParams).toEqual([userId, walletId, 'inj1contract']);
      const [jobSql, jobParams] = txQuery.mock.calls[1];
      expect(jobSql).toContain(`'MINT_PARENT'`);
      expect(jobSql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
      expect(jobParams).toEqual([newNftId, `mint-parent:${userId}`]);
    });

    it('records the PENDING_CONTRACT_DEPLOY placeholder when NFT_CONTRACT_ADDRESS is not set', async () => {
      const { service, txQuery } = setup();
      await service.enqueueParentMint(userId, walletId);
      expect(txQuery.mock.calls[0][1]).toEqual([userId, walletId, 'PENDING_CONTRACT_DEPLOY']);
    });

    it('returns null and queues no job when the user already has a parent NFT (1 parent per user)', async () => {
      const { service, txQuery } = setup({ nftInserted: false });
      await expect(service.enqueueParentMint(userId, walletId)).resolves.toBeNull();
      expect(txQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe('enqueueChildMint', () => {
    it('links the child to the user\'s parent NFT and queues MINT_CHILD keyed by the submission', async () => {
      const { service, txQuery } = setup({ contract: 'inj1contract', parentExists: true });
      await expect(service.enqueueChildMint(userId, walletId, bountyId, submissionId)).resolves.toEqual({ nftId: newNftId, parentId: parentNftId });
      expect(txQuery.mock.calls[0][1]).toEqual([userId]);
      const [childSql, childParams] = txQuery.mock.calls[1];
      expect(childSql).toContain(`'BOUNTY_COMPLETION_CHILD'`);
      expect(childParams).toEqual([userId, walletId, parentNftId, bountyId, submissionId, 'inj1contract']);
      const [jobSql, jobParams] = txQuery.mock.calls[2];
      expect(jobSql).toContain(`'MINT_CHILD'`);
      expect(jobParams).toEqual([newNftId, `mint-child:${submissionId}`]);
    });

    it('creates the child without a parent link when the user has no parent NFT yet', async () => {
      const { service, txQuery } = setup({ parentExists: false });
      await expect(service.enqueueChildMint(userId, walletId, bountyId, submissionId)).resolves.toEqual({ nftId: newNftId, parentId: null });
      expect(txQuery.mock.calls[1][1]![2]).toBeNull();
    });

    it('returns null and queues no job when the submission already has a child NFT', async () => {
      const { service, txQuery } = setup({ parentExists: true, nftInserted: false });
      await expect(service.enqueueChildMint(userId, walletId, bountyId, submissionId)).resolves.toBeNull();
      expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO nft_job'))).toBe(false);
    });
  });

  it('listByUser returns the user\'s NFTs in creation order', async () => {
    const { service, query } = setup();
    await expect(service.listByUser(userId)).resolves.toEqual([{ id: 'a' }, { id: 'b' }]);
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([userId]);
    expect(sql).toContain('WHERE owner_user_id = $1');
    expect(sql).toContain('ORDER BY created_at');
  });
});
