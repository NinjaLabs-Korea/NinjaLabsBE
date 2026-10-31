import { ConflictException } from '@nestjs/common';
import { Wallet } from 'ethers';
import { createMockDb, type SqlHandler } from '../test-support/mock-db';
import { WalletsService } from './wallets.service';

const mockCanonicalInjectiveAddress = 'inj1canonicaladdress';

jest.mock('@injectivelabs/sdk-ts', () => ({
  getInjectiveAddress: jest.fn(() => mockCanonicalInjectiveAddress),
  getEthereumAddress: jest.fn((address: string) => address),
}));

jest.mock('../common/crypto/adr36', () => ({
  verifyAdr36Signature: jest.fn(() => false),
}));

/**
 * 분기만 본다 (챌린지 없음/만료, 소비 경합, 잘못된 서명, 유니크 위반 매핑, 재시도 응답). 엄격 mock DB라 STMT에 없는 SQL은
 * `Unexpected SQL`로 실패하고, 매칭은 공백을 접은 SQL에 적용된다. 문장 순서와 SQL 절(advisory lock, FOR UPDATE, 조건부 소비,
 * 롤백 시 챌린지 소비 취소)은 실 Postgres 위의 `src/test-db/wallets.db-spec.ts`가 행으로 단언한다.
 */
const STMT = {
  lock: /^SELECT pg_advisory_xact_lock/,
  purge: /^DELETE FROM wallet_verification_challenge/,
  issue: /^INSERT INTO wallet_verification_challenge/,
  lookup: /^SELECT id, message, .* FROM wallet_verification_challenge/,
  consume: /^UPDATE wallet_verification_challenge SET used_at = now\(\)/,
  agents: /^SELECT wallet_address FROM agent WHERE owner_user_id/,
  walletInsert: /^INSERT INTO wallet /,
  onboarding: /^UPDATE "user" SET onboarding_step/,
  myWallet: /^SELECT id, chain, address, verified_at, created_at FROM wallet/,
} as const;

const on = (match: RegExp, reply: SqlHandler['reply']): SqlHandler => ({ match, reply });

describe('WalletsService EVM verification', () => {
  it('verifies personal_sign, stores the canonical inj1 address and the key recovered from the signature, and registers the mint job on the same tx client', async () => {
    const signer = Wallet.createRandom();
    let challengeMessage = '';
    let insertedWallet: unknown[] | undefined;
    // pool and tx paths route through the same strict handler list
    const { database, db, txClient } = createMockDb({
      strict: true,
      handlers: [
        on(STMT.myWallet, () => ({ rowCount: 1, rows: [{ id: 'wallet-id', chain: 'INJECTIVE', address: mockCanonicalInjectiveAddress }] })),
        on(STMT.lock, () => ({ rowCount: 1, rows: [] })),
        on(STMT.purge, () => ({ rowCount: 0, rows: [] })),
        on(STMT.issue, (params) => {
          challengeMessage = params![3] as string;
          return { rowCount: 1, rows: [{ id: 'challenge-id', nonce: params![2], message: challengeMessage }] };
        }),
        on(STMT.lookup, () => ({ rowCount: 1, rows: [{ id: 'challenge-id', message: challengeMessage, valid: true }] })),
        on(STMT.consume, () => ({ rowCount: 1, rows: [{ id: 'challenge-id' }] })),
        on(STMT.agents, () => ({ rowCount: 0, rows: [] })),
        on(STMT.walletInsert, (params) => { insertedWallet = params; return { rowCount: 1, rows: [{ id: 'wallet-id' }] }; }),
        on(STMT.onboarding, () => ({ rowCount: 1, rows: [] })),
      ],
    });
    const nfts = { enqueueParentMintInTransaction: jest.fn(async () => ({ nftId: 'nft-id' })) };
    const service = new WalletsService(database, nfts as never);

    await service.createChallenge('user-id', signer.address.toLowerCase());
    const signature = await signer.signMessage(challengeMessage);
    await service.verifySignature('user-id', signer.address.toLowerCase(), signature);

    expect(insertedWallet).toEqual([
      'user-id',
      mockCanonicalInjectiveAddress,
      signer.signingKey.compressedPublicKey, // recovered from the EIP-191 signature (never a client-supplied key)
    ]);
    // 부모 NFT 민팅 잡은 지갑 INSERT와 같은 트랜잭션 클라이언트로 등록된다 (커밋 후 별도 호출 아님)
    expect(nfts.enqueueParentMintInTransaction).toHaveBeenCalledWith(txClient, 'user-id', 'wallet-id');
    expect(nfts.enqueueParentMintInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(db.query.mock.invocationCallOrder.at(-1)!);
  });
});

describe('WalletsService createChallenge', () => {
  it('issues the challenge inside one transaction and never uses the pool path', async () => {
    const signer = Wallet.createRandom();
    const { database, db, txQuery } = createMockDb({
      strict: true,
      handlers: [
        on(STMT.lock, () => ({ rowCount: 1, rows: [] })),
        on(STMT.purge, () => ({ rowCount: 2, rows: [] })),
        on(STMT.issue, (params) => ({ rowCount: 1, rows: [{ id: 'challenge-id', nonce: params![2], message: params![3] }] })),
      ],
    });
    const service = new WalletsService(database, {} as never);

    const challenge = await service.createChallenge('user-id', signer.address.toLowerCase());

    expect(challenge).toMatchObject({ id: 'challenge-id' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    // lock, purge and insert all bind the same normalized (user, wallet) pair; the SQL clauses are asserted on a real database
    const bound = (txQuery.mock.calls as Array<[string, unknown[]]>).map(([, params]) => params.slice(0, 2));
    expect(bound).toEqual([['user-id', signer.address], ['user-id', signer.address], ['user-id', signer.address]]);
  });
});

describe('WalletsService challenge lookup', () => {
  function verify(rows: Array<{ id: string; message: string; valid: boolean }>, consumeRowCount = 1, walletInsert?: Error) {
    const mock = createMockDb({
      strict: true,
      handlers: [
        on(STMT.lookup, () => ({ rowCount: rows.length, rows })),
        on(STMT.consume, () => ({ rowCount: consumeRowCount, rows: consumeRowCount ? [{ id: rows[0]?.id }] : [] })),
        on(STMT.agents, () => ({ rowCount: 0, rows: [] })),
        on(STMT.walletInsert, () => {
          if (walletInsert) throw walletInsert;
          return { rowCount: 1, rows: [{ id: 'wallet-id' }] };
        }),
        on(STMT.onboarding, () => ({ rowCount: 1, rows: [] })),
      ],
    });
    const nfts = { enqueueParentMintInTransaction: jest.fn() };
    const service = new WalletsService(mock.database, nfts as never);
    const signer = Wallet.createRandom();
    /** tx 안에서 나간 문장 중 `match`에 맞는 개수 (MockDb.txStatements가 공백을 접어 비교한다) */
    const txRan = (match: RegExp) => mock.txStatements(match).length;
    return {
      db: mock.db, txQuery: mock.txQuery, txRan, nfts, signer,
      run: (signature = '0xsig') => service.verifySignature('user-id', signer.address, signature),
    };
  }

  it('reports CHALLENGE_NOT_FOUND when no challenge was ever issued for the address (the lookup is the only statement, inside the tx)', async () => {
    const { db, txQuery, run } = verify([]);
    await expect(run()).rejects.toMatchObject({ message: 'CHALLENGE_NOT_FOUND' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('reports CHALLENGE_EXPIRED when only used or expired challenges exist, without touching anything', async () => {
    const { txQuery, run } = verify([{ id: 'old', message: 'm', valid: false }]);
    await expect(run()).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('reports CHALLENGE_EXPIRED when the conditional consume matches no row (used or expired between lookup and consume), storing no wallet', async () => {
    const { txRan, nfts, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 0);
    const signature = await signer.signMessage('m');
    await expect(run(signature)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    expect(txRan(STMT.consume)).toBe(1);
    expect(txRan(STMT.walletInsert)).toBe(0);
    expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
  });

  it('rejects a bad signature before consuming the challenge', async () => {
    const { txRan, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }]);
    await expect(run('0xdeadbeef')).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(txRan(STMT.consume)).toBe(0);
  });

  it('maps a unique violation on the wallet INSERT (uq_wallet_chain_address_active) to 409 WALLET_LINKED_TO_OTHER_ACCOUNT', async () => {
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "uq_wallet_chain_address_active"'), { code: '23505', constraint: 'uq_wallet_chain_address_active' });
    const { db, txRan, nfts, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 1, duplicate);
    db.query.mockResolvedValue({ rowCount: 0, rows: [] }); // the user has no wallet of their own: a real conflict
    const signature = await signer.signMessage('m');
    const error = await run(signature).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('WALLET_LINKED_TO_OTHER_ACCOUNT');
    // nothing after the failed INSERT ran (the rollback of the challenge consumption is asserted on a real database)
    expect(txRan(STMT.walletInsert)).toBe(1);
    expect(txRan(STMT.onboarding)).toBe(0);
    expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
    // the only read after the failure is the "is it already my own wallet?" check - nothing is returned as success
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('answers a verify retry for the wallet the user already linked with that wallet instead of 409 (first response lost)', async () => {
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "uq_wallet_primary_per_user"'), { code: '23505', constraint: 'uq_wallet_primary_per_user' });
    const { db, nfts, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 1, duplicate);
    const linked = { id: 'wallet-id', chain: 'INJECTIVE', address: mockCanonicalInjectiveAddress };
    db.query.mockResolvedValue({ rowCount: 1, rows: [linked] });
    const signature = await signer.signMessage('m');
    await expect(run(signature)).resolves.toEqual(linked);
    expect(nfts.enqueueParentMintInTransaction).not.toHaveBeenCalled();
  });

  it("still answers 409 when the user's own wallet is a different address", async () => {
    const duplicate = Object.assign(new Error('duplicate key value violates unique constraint "uq_wallet_primary_per_user"'), { code: '23505', constraint: 'uq_wallet_primary_per_user' });
    const { db, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 1, duplicate);
    db.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 'other', address: 'inj1someoneelse' }] });
    const signature = await signer.signMessage('m');
    await expect(run(signature)).rejects.toMatchObject({ message: 'ACCOUNT_ALREADY_HAS_WALLET' });
  });

  it.each([
    ['another unique index (e.g. an NFT job key)', 'uq_nft_job_idempotency'],
    ['no constraint name', undefined],
  ])('rethrows a unique violation from %s unchanged: no 409 and no "is it my wallet" lookup', async (_what, constraint) => {
    const duplicate = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    const { db, signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 1, duplicate);
    db.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const signature = await signer.signMessage('m');
    await expect(run(signature)).rejects.toBe(duplicate);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('propagates other INSERT failures unchanged (not every error is a duplicate wallet)', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const { signer, run } = verify([{ id: 'challenge-id', message: 'm', valid: true }], 1, failure);
    const signature = await signer.signMessage('m');
    await expect(run(signature)).rejects.toBe(failure);
  });
});
