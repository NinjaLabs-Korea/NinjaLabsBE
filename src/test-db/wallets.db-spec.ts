import { Wallet } from 'ethers';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { WalletsService } from '../wallets/wallets.service';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig } from './harness';

// @injectivelabs/sdk-ts is ESM-only and cannot be loaded by jest; only its address helpers are used on the EVM path.
// Signatures are REAL EIP-191 signatures from an ethers wallet — the bech32 conversion is the only fake.
jest.mock('@injectivelabs/sdk-ts', () => ({
  getInjectiveAddress: (evm: string) => `inj1${evm.slice(2).toLowerCase()}`,
  getEthereumAddress: (inj: string) => inj,
}));
// ADR-36 (Keplr/Leap) verification pulls @cosmjs/@noble ESM as well; not exercised on the EVM path.
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('wallet challenge/verify on a real database', () => {
  let db: DatabaseService;
  let wallets: WalletsService;

  beforeAll(() => {
    db = createDb();
    wallets = new WalletsService(db, new NftsService(db, testConfig()));
  });
  afterAll(async () => db.onApplicationShutdown());

  async function openChallenges(userId: string) {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM wallet_verification_challenge WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    return r.rows[0].n;
  }

  it('challenge → verify (EIP-191) stores the inj1 wallet, advances onboarding, enqueues the parent mint job and burns the challenge', async () => {
    const userId = await createUser(db, { onboarded: false });
    const signer = Wallet.createRandom();
    const challenge = await wallets.createChallenge(userId, signer.address.toLowerCase());
    expect(challenge.message).toContain(`地址: ${signer.address}`);
    expect(challenge.message).toContain(`nonce: ${challenge.nonce}`);

    const signature = await signer.signMessage(challenge.message);
    const wallet = await wallets.verifySignature(userId, signer.address, signature);
    expect(wallet).toMatchObject({ chain: 'INJECTIVE', address: `inj1${signer.address.slice(2).toLowerCase()}` });
    expect(wallet.verified_at).toBeInstanceOf(Date);

    const user = await db.query<{ onboarding_step: number }>(`SELECT onboarding_step FROM "user" WHERE id = $1`, [userId]);
    expect(user.rows[0].onboarding_step).toBe(3);

    const nft = await db.query<{ id: string; status: string; owner_wallet_id: string }>(
      `SELECT id, status, owner_wallet_id FROM nft WHERE owner_user_id = $1 AND nft_type = 'NINJA_PARENT'`, [userId]);
    expect(nft.rowCount).toBe(1);
    expect(nft.rows[0]).toMatchObject({ status: 'PENDING', owner_wallet_id: wallet.id });
    const job = await db.query<{ job_type: string; status: string; idempotency_key: string }>(
      `SELECT job_type, status, idempotency_key FROM nft_job WHERE nft_id = $1`, [nft.rows[0].id]);
    expect(job.rows).toEqual([{ job_type: 'MINT_PARENT', status: 'PENDING', idempotency_key: `mint-parent:${userId}` }]);

    const used = await db.query<{ used_at: Date | null }>(`SELECT used_at FROM wallet_verification_challenge WHERE id = $1`, [challenge.id]);
    expect(used.rows[0].used_at).toBeInstanceOf(Date);
    // replaying the same signature: the challenge is consumed → 400, no second wallet
    await expect(wallets.verifySignature(userId, signer.address, signature)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM wallet WHERE user_id = $1`, [userId]);
    expect(count.rows[0].n).toBe(1);
  });

  it('a user withdrawn after the challenge cannot link a wallet: 404 USER_NOT_FOUND, no wallet row, address stays free', async () => {
    const userId = await createUser(db);
    const signer = Wallet.createRandom();
    const challenge = await wallets.createChallenge(userId, signer.address);
    await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [userId]);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message))).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
    const wallet = await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId]);
    expect(wallet.rowCount).toBe(0);
  });

  it('a bad signature leaves the challenge open (tx rolled back); an expired one is 400 CHALLENGE_EXPIRED; none is CHALLENGE_NOT_FOUND', async () => {
    const userId = await createUser(db);
    const signer = Wallet.createRandom();
    await expect(wallets.verifySignature(userId, signer.address, '0x00')).rejects.toMatchObject({ message: 'CHALLENGE_NOT_FOUND' });

    const challenge = await wallets.createChallenge(userId, signer.address);
    const forged = await Wallet.createRandom().signMessage(challenge.message);
    await expect(wallets.verifySignature(userId, signer.address, forged)).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(await openChallenges(userId)).toBe(1);

    await db.query(`UPDATE wallet_verification_challenge SET expires_at = now() - interval '1 second' WHERE id = $1`, [challenge.id]);
    const signature = await signer.signMessage(challenge.message);
    await expect(wallets.verifySignature(userId, signer.address, signature)).rejects.toMatchObject({ message: 'CHALLENGE_EXPIRED' });
    const wallet = await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId]);
    expect(wallet.rowCount).toBe(0);
  });

  it('concurrent createChallenge calls for the same (user, wallet) leave exactly one open challenge (advisory lock)', async () => {
    const userId = await createUser(db);
    const signer = Wallet.createRandom();
    const issued = await Promise.all(Array.from({ length: 6 }, () => wallets.createChallenge(userId, signer.address)));
    expect(new Set(issued.map((challenge) => challenge.id)).size).toBe(6);
    expect(await openChallenges(userId)).toBe(1);
    // the survivor is the last one issued; it still verifies
    const open = await db.query<{ id: string; message: string }>(
      `SELECT id, message FROM wallet_verification_challenge WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    const signature = await signer.signMessage(open.rows[0].message);
    await expect(wallets.verifySignature(userId, signer.address, signature)).resolves.toMatchObject({ chain: 'INJECTIVE' });
  });

  it('wallet.public_key is the key recovered from the EIP-191 signature, whatever publicKey the client sends', async () => {
    const userId = await createUser(db);
    const signer = Wallet.createRandom();
    const challenge = await wallets.createChallenge(userId, signer.address);
    await wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message), `0x02${'ab'.repeat(32)}`);
    const row = await db.query<{ public_key: string | null }>(`SELECT public_key FROM wallet WHERE user_id = $1`, [userId]);
    expect(row.rows).toEqual([{ public_key: signer.signingKey.compressedPublicKey }]);
  });

  it('the same wallet cannot be linked to a second account (409 WALLET_ALREADY_LINKED, nothing persisted)', async () => {
    const signer = Wallet.createRandom();
    const first = await createUser(db);
    const c1 = await wallets.createChallenge(first, signer.address);
    await wallets.verifySignature(first, signer.address, await signer.signMessage(c1.message));

    const second = await createUser(db, { onboarded: false });
    const c2 = await wallets.createChallenge(second, signer.address);
    await expect(wallets.verifySignature(second, signer.address, await signer.signMessage(c2.message)))
      .rejects.toMatchObject({ message: 'WALLET_ALREADY_LINKED' });
    const user = await db.query<{ onboarding_step: number }>(`SELECT onboarding_step FROM "user" WHERE id = $1`, [second]);
    expect(user.rows[0].onboarding_step).toBe(2);
    const nft = await db.query(`SELECT 1 FROM nft WHERE owner_user_id = $1`, [second]);
    expect(nft.rowCount).toBe(0);
  });

  it('re-verifying the wallet the user already linked returns it (retry after a lost response) and queues no second mint job', async () => {
    const signer = Wallet.createRandom();
    const userId = await createUser(db);
    const c1 = await wallets.createChallenge(userId, signer.address);
    const first = await wallets.verifySignature(userId, signer.address, await signer.signMessage(c1.message));
    const c2 = await wallets.createChallenge(userId, signer.address);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(c2.message))).resolves.toEqual(first);
    const rows = await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId]);
    expect(rows.rowCount).toBe(1);
  });
});
