import { Wallet } from 'ethers';
import { WalletsService } from './wallets.service';

const mockCanonicalInjectiveAddress = 'inj1canonicaladdress';

jest.mock('@injectivelabs/sdk-ts', () => ({
  getInjectiveAddress: jest.fn(() => mockCanonicalInjectiveAddress),
  getEthereumAddress: jest.fn((address: string) => address),
}));

jest.mock('../common/crypto/adr36', () => ({
  verifyAdr36Signature: jest.fn(() => false),
}));

describe('WalletsService EVM verification', () => {
  it('verifies personal_sign, stores the canonical inj1 address, and advances onboarding', async () => {
    const signer = Wallet.createRandom();
    let challengeMessage = '';
    const txQuery = jest.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO wallet ')) return { rowCount: 1, rows: [{ id: 'wallet-id' }] };
      return { rowCount: 1, rows: [] };
    });
    const db = {
      query: jest.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO wallet_verification_challenge')) {
          challengeMessage = params[3] as string;
          return {
            rowCount: 1,
            rows: [{ id: 'challenge-id', nonce: params[2], message: challengeMessage }],
          };
        }
        if (sql.includes('SELECT id, message FROM wallet_verification_challenge')) {
          return { rowCount: 1, rows: [{ id: 'challenge-id', message: challengeMessage }] };
        }
        if (sql.includes('SELECT id, chain, address')) {
          return {
            rowCount: 1,
            rows: [{ id: 'wallet-id', chain: 'INJECTIVE', address: mockCanonicalInjectiveAddress }],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
        callback({ query: txQuery }),
      ),
    };
    const nfts = { enqueueParentMint: jest.fn(async () => ({ nftId: 'nft-id' })) };
    const service = new WalletsService(db as never, nfts as never);

    await service.createChallenge('user-id', signer.address.toLowerCase());
    const signature = await signer.signMessage(challengeMessage);
    await service.verifySignature('user-id', signer.address.toLowerCase(), signature);

    const walletInsert = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO wallet '));
    expect(walletInsert?.[1]).toEqual([
      'user-id',
      mockCanonicalInjectiveAddress,
      null,
    ]);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('onboarding_step'))).toBe(true);
    expect(nfts.enqueueParentMint).toHaveBeenCalledWith('user-id', 'wallet-id');
  });
});
