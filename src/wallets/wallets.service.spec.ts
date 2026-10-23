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
      if (sql.includes('INSERT INTO wallet_verification_challenge')) {
        challengeMessage = params[3] as string;
        return {
          rowCount: 1,
          rows: [{ id: 'challenge-id', nonce: params[2], message: challengeMessage }],
        };
      }
      if (sql.includes('FROM wallet_verification_challenge')) {
        return { rowCount: 1, rows: [{ id: 'challenge-id', message: challengeMessage, valid: true }] };
      }
      if (sql.includes('SET used_at = now()')) return { rowCount: 1, rows: [{ id: 'challenge-id' }] };
      return { rowCount: 1, rows: [] };
    });
    const db = {
      query: jest.fn(async (sql: string, _params: unknown[]) => {
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
    const nfts = { enqueueParentMintInTransaction: jest.fn(async () => ({ nftId: 'nft-id' })) };
    const service = new WalletsService(db as never, nfts as never);

    await service.createChallenge('user-id', signer.address.toLowerCase());
    const signature = await signer.signMessage(challengeMessage);
    await service.verifySignature('user-id', signer.address.toLowerCase(), signature);

    // verify runs entirely in one tx: locked lookup → conditional consume → wallet INSERT → onboarding → mint job
    const verifySqls = txQuery.mock.calls.map(([sql]) => sql as string).filter((sql) => !sql.includes('pg_advisory_xact_lock') && !sql.includes('DELETE FROM') && !sql.includes('INSERT INTO wallet_verification_challenge'));
    expect(verifySqls[0]).toContain('FROM wallet_verification_challenge');
    expect(verifySqls[0]).toContain('ORDER BY valid DESC, created_at DESC');
    expect(verifySqls[0]).toContain('FOR UPDATE');
    expect(verifySqls[1]).toContain('UPDATE wallet_verification_challenge SET used_at = now()');
    expect(verifySqls[1]).toContain('WHERE id = $1 AND used_at IS NULL AND expires_at > now()');
    expect(verifySqls[1]).toContain('RETURNING id');
    expect(verifySqls[2]).toContain('INSERT INTO wallet ');
    const walletInsert = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO wallet '));
    expect(walletInsert?.[1]).toEqual([
      'user-id',
      mockCanonicalInjectiveAddress,
      null,
    ]);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('onboarding_step'))).toBe(true);
    // 부모 NFT 민팅 잡은 지갑 INSERT와 같은 트랜잭션 클라이언트로 등록된다 (커밋 후 별도 호출 아님)
    expect(nfts.enqueueParentMintInTransaction).toHaveBeenCalledWith({ query: txQuery }, 'user-id', 'wallet-id');
    expect(nfts.enqueueParentMintInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(db.query.mock.invocationCallOrder.at(-1)!);
  });
});

describe('WalletsService createChallenge', () => {
  it('deletes prior unused challenges for the same (user, wallet) and inserts the new one in a single transaction', async () => {
    const signer = Wallet.createRandom();
    const txQuery = jest.fn(async (sql: string, params: unknown[]) =>
      sql.includes('INSERT') ? { rowCount: 1, rows: [{ id: 'challenge-id', nonce: params[2], message: params[3] }] } : { rowCount: 2, rows: [] });
    const db = {
      query: jest.fn(),
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) => callback({ query: txQuery })),
    };
    const service = new WalletsService(db as never, {} as never);

    const challenge = await service.createChallenge('user-id', signer.address.toLowerCase());

    expect(challenge).toMatchObject({ id: 'challenge-id' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    const [lock, purge, insert] = txQuery.mock.calls;
    // per-(user, wallet) advisory lock first, so concurrent issues serialize and at most one open challenge survives
    expect(lock[0]).toContain('pg_advisory_xact_lock(hashtext($1::text || \':\' || $2::text))');
    expect(lock[1]).toEqual(['user-id', signer.address]);
    expect(purge[0]).toContain('DELETE FROM wallet_verification_challenge');
    expect(purge[0]).toContain('WHERE user_id = $1 AND wallet_address = $2 AND used_at IS NULL');
    expect(purge[1]).toEqual(['user-id', signer.address]);
    expect(insert[0]).toContain('INSERT INTO wallet_verification_challenge');
    expect(insert[1].slice(0, 2)).toEqual(['user-id', signer.address]);
  });
});

describe('WalletsService challenge lookup', () => {
  function verify(rows: Array<{ id: string; message: string; valid: boolean }>, consumeRowCount = 1) {
    const txQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM wallet_verification_challenge')) return { rowCount: rows.length, rows };
      if (sql.includes('SET used_at = now()')) return { rowCount: consumeRowCount, rows: consumeRowCount ? [{ id: rows[0]?.id }] : [] };
      return { rowCount: 1, rows: [{ id: 'wallet-id' }] };
    });
    const db = {
      query: jest.fn(),
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) => callback({ query: txQuery })),
    };
    const nfts = { enqueueParentMintInTransaction: jest.fn() };
    const service = new WalletsService(db as never, nfts as never);
    const signer = Wallet.createRandom();
    return {
      db, txQuery, nfts, signer,
      run: (signature = '0xsig') => service.verifySignature('user-id', signer.address, signature),
    };
  }

  it('reports CHALLENGE_NOT_FOUND when no challenge was ever issued for the address (locked lookup inside the tx)', async () => {
    const { db, txQuery, run } = verify([]);
    await expect(run()).rejects.toMatchObject({ message: 'CHALLENGE_NOT_FOUND' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][0]).toContain('ORDER BY valid DESC, created_at DESC');
    expect(txQuery.mock.calls[0][0]).toContain('FOR UPDATE');
  });

  it('reports CHALLENGE_EXPIRED when only used or expired challenges exist, without touching anything', async () => {
    const { txQuery, run } = verify([{ id: 'old', message: 'm', valid: false }]);
    await expect(run()).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('reports CHALLENGE_EXPIRED when the conditional consume matches no row (used or expired between lookup and consume), storing no wallet', async () => {
    const { txQuery, nfts, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 0);
    const signature = await signer.signMessage('m');
    await expect(run(signature)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    const consume = txQuery.mock.calls[1];
    expect(consume[0]).toContain('UPDATE wallet_verification_challenge SET used_at = now()');
    expect(consume[0]).toContain('WHERE id = $1 AND used_at IS NULL AND expires_at > now()');
    expect(consume[0]).toContain('RETURNING id');
    expect(consume[1]).toEqual(['challenge-id']);
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO wallet '))).toBe(false);
    expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before consuming the challenge (the tx rolls back, the challenge stays open)', async () => {
    const { txQuery, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }]);
    await expect(run('0xdeadbeef')).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });
});
