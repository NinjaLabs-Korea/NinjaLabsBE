import { Wallet } from 'ethers';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';
import { disconnectAllWalletsOfUser } from '../wallets/wallet-disconnection';
import { WalletsService } from '../wallets/wallets.service';
import { describeDb } from './describe-db';
import { createDb, createUser, testConfig } from './harness';

// @injectivelabs/sdk-ts is ESM-only and cannot be loaded by jest; only its address helpers are used on the EVM path.
// Signatures are REAL EIP-191 signatures from an ethers wallet - the bech32 conversion is the only fake.
jest.mock('@injectivelabs/sdk-ts', () => ({
  getInjectiveAddress: (evm: string) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new Error('invalid address'); // like the real SDK, a malformed 0x value throws
    return `inj1${evm.slice(2).toLowerCase()}`;
  },
  getEthereumAddress: (inj: string) => (inj.startsWith('inj1') ? `0x${inj.slice(4)}` : inj), // inverse of getInjectiveAddress, so inj1 -> 0x -> inj1 round-trips
}));
// ADR-36 (Keplr/Leap) verification pulls @cosmjs/@noble ESM as well; not exercised on the EVM path.
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const adr36 = verifyAdr36Signature as jest.MockedFunction<typeof verifyAdr36Signature>;

describeDb('wallet challenge/verify on a real database', () => {
  let db: DatabaseService;
  let wallets: WalletsService;

  beforeAll(() => {
    db = createDb();
    wallets = new WalletsService(db, new NftsService(db, testConfig()));
  });
  afterAll(async () => db.onApplicationShutdown());
  beforeEach(() => { adr36.mockReset().mockReturnValue(false); });

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

  it('the same wallet cannot be linked to a second account (409 WALLET_LINKED_TO_OTHER_ACCOUNT, nothing persisted)', async () => {
    const signer = Wallet.createRandom();
    const first = await createUser(db);
    const c1 = await wallets.createChallenge(first, signer.address);
    await wallets.verifySignature(first, signer.address, await signer.signMessage(c1.message));

    const second = await createUser(db, { onboarded: false });
    const c2 = await wallets.createChallenge(second, signer.address);
    await expect(wallets.verifySignature(second, signer.address, await signer.signMessage(c2.message)))
      .rejects.toMatchObject({ message: 'WALLET_LINKED_TO_OTHER_ACCOUNT' });
    const user = await db.query<{ onboarding_step: number }>(`SELECT onboarding_step FROM "user" WHERE id = $1`, [second]);
    expect(user.rows[0].onboarding_step).toBe(2);
    const nft = await db.query(`SELECT 1 FROM nft WHERE owner_user_id = $1`, [second]);
    expect(nft.rowCount).toBe(0);
  });

  it('a second, different address for an account that already has a primary wallet is 409 ACCOUNT_ALREADY_HAS_WALLET', async () => {
    const userId = await createUser(db);
    const first = Wallet.createRandom();
    const c1 = await wallets.createChallenge(userId, first.address);
    await wallets.verifySignature(userId, first.address, await first.signMessage(c1.message));
    const second = Wallet.createRandom();
    const c2 = await wallets.createChallenge(userId, second.address);
    await expect(wallets.verifySignature(userId, second.address, await second.signMessage(c2.message)))
      .rejects.toMatchObject({ message: 'ACCOUNT_ALREADY_HAS_WALLET' });
    expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId])).rowCount).toBe(1);
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
  it('issuing a challenge deletes only that (user, wallet) pair\'s unused challenges: a used one and another wallet\'s open challenge survive', async () => {
    const userId = await createUser(db);
    const signer = Wallet.createRandom();
    const other = Wallet.createRandom();
    const used = await wallets.createChallenge(userId, signer.address);
    await db.query(`UPDATE wallet_verification_challenge SET used_at = now() WHERE id = $1`, [used.id]);
    const otherWallet = await wallets.createChallenge(userId, other.address);
    const stale = await wallets.createChallenge(userId, signer.address);
    const fresh = await wallets.createChallenge(userId, signer.address);

    const rows = await db.query<{ id: string }>(`SELECT id FROM wallet_verification_challenge WHERE user_id = $1 ORDER BY created_at`, [userId]);
    const ids = rows.rows.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([used.id, otherWallet.id, fresh.id]));
    expect(ids).not.toContain(stale.id);
    expect(ids).toHaveLength(3);
  });

  it('a unique violation rolls the whole verify back: the challenge stays open and no onboarding step, wallet or mint job is left behind', async () => {
    const signer = Wallet.createRandom();
    const first = await createUser(db);
    const c1 = await wallets.createChallenge(first, signer.address);
    await wallets.verifySignature(first, signer.address, await signer.signMessage(c1.message));

    const second = await createUser(db, { onboarded: false });
    const c2 = await wallets.createChallenge(second, signer.address);
    await expect(wallets.verifySignature(second, signer.address, await signer.signMessage(c2.message)))
      .rejects.toMatchObject({ message: 'WALLET_LINKED_TO_OTHER_ACCOUNT' });
    expect(await openChallenges(second)).toBe(1); // the consume UPDATE was rolled back with the failed wallet INSERT
    expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [second])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM nft_job j JOIN nft n ON n.id = j.nft_id WHERE n.owner_user_id = $1`, [second])).rowCount).toBe(0);
  });

  it('a live agent of the user with the same wallet blocks linking it as the owner wallet (400 AGENT_WALLET_IS_OWNER_WALLET), a revoked one does not', async () => {
    const signer = Wallet.createRandom();
    const injAddress = `inj1${signer.address.slice(2).toLowerCase()}`;
    const userId = await createUser(db, { onboarded: false });
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at) VALUES ($1, 'twin', $2, 'ACTIVE', now()) RETURNING id`, [userId, injAddress]);
    const c1 = await wallets.createChallenge(userId, signer.address);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(c1.message)))
      .rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
    expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId])).rowCount).toBe(0);
    expect(await openChallenges(userId)).toBe(1); // consumption rolled back too

    await db.query(`UPDATE agent SET status = 'REVOKED' WHERE id = $1`, [agent.rows[0].id]);
    const c2 = await wallets.createChallenge(userId, signer.address);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(c2.message)))
      .resolves.toMatchObject({ address: injAddress });
  });

  it('the onboarding step only moves forward: a user already past step 3 keeps their step when linking a wallet', async () => {
    const userId = await createUser(db, { onboarded: true });
    await db.query(`UPDATE "user" SET onboarding_step = 5 WHERE id = $1`, [userId]);
    const signer = Wallet.createRandom();
    const challenge = await wallets.createChallenge(userId, signer.address);
    await wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message));
    const user = await db.query<{ onboarding_step: number }>(`SELECT onboarding_step FROM "user" WHERE id = $1`, [userId]);
    expect(user.rows[0].onboarding_step).toBe(5);
  });
  describe('ADR-36 (Keplr/Leap, inj1...) with the cryptography switched by a verdict', () => {
    // a real compressed secp256k1 key in the base64 form wallets report
    const keyOf = (signer: { signingKey: { compressedPublicKey: string } }) => Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64');
    const injOf = (signer: { address: string }) => `inj1${signer.address.slice(2).toLowerCase()}`;

    it('verifies against the stored challenge message with the supplied key, then stores the inj1 address and that key and burns the challenge', async () => {
      const userId = await createUser(db, { onboarded: false });
      const signer = Wallet.createRandom();
      const inj = injOf(signer);
      adr36.mockReturnValue(true);
      const challenge = await wallets.createChallenge(userId, inj);
      await expect(wallets.verifySignature(userId, inj, 'base64-sig', keyOf(signer))).resolves.toMatchObject({ chain: 'INJECTIVE', address: inj });
      expect(adr36).toHaveBeenCalledWith(inj, challenge.message, keyOf(signer), 'base64-sig');
      const row = await db.query(`SELECT address, public_key FROM wallet WHERE user_id = $1`, [userId]);
      expect(row.rows).toEqual([{ address: inj, public_key: keyOf(signer) }]);
      expect(await openChallenges(userId)).toBe(0);
    });

    it('without a public key the ADR-36 path cannot verify: 401 INVALID_SIGNATURE, verifier not consulted, challenge left open, no wallet', async () => {
      const userId = await createUser(db, { onboarded: false });
      const inj = injOf(Wallet.createRandom());
      adr36.mockReturnValue(true); // would pass if it were (wrongly) consulted
      await wallets.createChallenge(userId, inj);
      await expect(wallets.verifySignature(userId, inj, 'base64-sig')).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
      expect(adr36).not.toHaveBeenCalled();
      expect(await openChallenges(userId)).toBe(1);
      expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId])).rowCount).toBe(0);
    });

    it('a signature the verifier refuses is 401 INVALID_SIGNATURE: no wallet, challenge still open for another try', async () => {
      const userId = await createUser(db, { onboarded: false });
      const signer = Wallet.createRandom();
      const inj = injOf(signer);
      await wallets.createChallenge(userId, inj);
      await expect(wallets.verifySignature(userId, inj, 'sig', keyOf(signer))).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
      expect(adr36).toHaveBeenCalledTimes(1);
      expect(await openChallenges(userId)).toBe(1);
      expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId])).rowCount).toBe(0);
    });

    it('an EVM signature over the challenge message cannot be replayed on the inj1 form of the same account (the scheme follows the address form)', async () => {
      const userId = await createUser(db, { onboarded: false });
      const signer = Wallet.createRandom();
      const inj = injOf(signer);
      const challenge = await wallets.createChallenge(userId, inj);
      await expect(wallets.verifySignature(userId, inj, await signer.signMessage(challenge.message))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    });
  });

  it('a signature over an older, superseded challenge message is refused: only the latest challenge for the pair exists', async () => {
    const userId = await createUser(db, { onboarded: false });
    const signer = Wallet.createRandom();
    const old = await wallets.createChallenge(userId, signer.address);
    const latest = await wallets.createChallenge(userId, signer.address);
    expect(await openChallenges(userId)).toBe(1);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(old.message))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(latest.message))).resolves.toMatchObject({ chain: 'INJECTIVE' });
  });

  it('an agent whose wallet is stored as 0x or as inj1 blocks the owner link in either form (400 AGENT_WALLET_IS_OWNER_WALLET), consuming nothing', async () => {
    for (const store of [(signer: { address: string }) => signer.address, (signer: { address: string }) => `inj1${signer.address.slice(2).toLowerCase()}`]) {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      await db.query(`INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at) VALUES ($1, 'twin', $2, 'ACTIVE', now())`, [userId, store(signer)]);
      const challenge = await wallets.createChallenge(userId, signer.address);
      await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message)))
        .rejects.toMatchObject({ status: 400, message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [userId])).rowCount).toBe(0);
      expect(await openChallenges(userId)).toBe(1);
    }
    // an agent on a different wallet does not get in the way
    const signer = Wallet.createRandom();
    const userId = await createUser(db, { onboarded: false });
    await db.query(`INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at) VALUES ($1, 'other', $2, 'ACTIVE', now())`, [userId, Wallet.createRandom().address]);
    const challenge = await wallets.createChallenge(userId, signer.address);
    await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message))).resolves.toMatchObject({ chain: 'INJECTIVE' });
  });

  it('myWallet: null without a connected primary wallet, the row with one, and not a disconnected one', async () => {
    const userId = await createUser(db);
    await expect(wallets.myWallet(userId)).resolves.toBeNull();
    const signer = Wallet.createRandom();
    const challenge = await wallets.createChallenge(userId, signer.address);
    const linked = await wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message));
    await expect(wallets.myWallet(userId)).resolves.toMatchObject({ id: linked.id, chain: 'INJECTIVE', address: `inj1${signer.address.slice(2).toLowerCase()}` });
    await db.query(`UPDATE wallet SET disconnected_at = now() WHERE user_id = $1`, [userId]);
    await expect(wallets.myWallet(userId)).resolves.toBeNull();
  });
  // ── 변이 확인(mutation/sql-mutants.mjs K 계열)에서 살아남았던 변형을 잡는 단언 ──
  describe('challenge ownership, selection order and expiry (survivors of the K mutants)', () => {
    async function insertChallenge(userId: string, address: string, message: string, options: { usedAt?: string | null; createdAt: string; expiresIn?: string }) {
      await db.query(
        `INSERT INTO wallet_verification_challenge (user_id, wallet_address, nonce, message, used_at, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + $7::interval)`,
        [userId, address, `n-${Math.random().toString(16).slice(2)}`, message, options.usedAt ?? null, options.createdAt, options.expiresIn ?? '5 minutes'],
      );
    }

    it('issuing a challenge never touches another user\'s open challenge for the same address', async () => {
      const signer = Wallet.createRandom();
      const [alice, bob] = [await createUser(db), await createUser(db)];
      await wallets.createChallenge(alice, signer.address);
      await wallets.createChallenge(bob, signer.address);
      expect(await openChallenges(alice)).toBe(1);
      expect(await openChallenges(bob)).toBe(1);
    });

    it('a challenge expires about 5 minutes after it was issued (not hours later)', async () => {
      const userId = await createUser(db);
      const challenge = await wallets.createChallenge(userId, Wallet.createRandom().address);
      const left = await db.query<{ seconds: number }>(
        `SELECT extract(epoch FROM (expires_at - now()))::float AS seconds FROM wallet_verification_challenge WHERE id = $1`, [challenge.id]);
      expect(left.rows[0].seconds).toBeGreaterThan(4 * 60);
      expect(left.rows[0].seconds).toBeLessThanOrEqual(5 * 60);
    });

    it('verify only ever uses the caller\'s own challenge: another user\'s signature over their challenge is 400 CHALLENGE_NOT_FOUND and leaves it open', async () => {
      const signer = Wallet.createRandom();
      const [alice, bob] = [await createUser(db, { onboarded: false }), await createUser(db, { onboarded: false })];
      const challenge = await wallets.createChallenge(alice, signer.address);
      const signature = await signer.signMessage(challenge.message);
      await expect(wallets.verifySignature(bob, signer.address, signature)).rejects.toMatchObject({ status: 400, message: 'CHALLENGE_NOT_FOUND' });
      expect(await openChallenges(alice)).toBe(1);
      expect((await db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [bob])).rowCount).toBe(0);
    });

    it('verify prefers the valid challenge over a newer used one', async () => {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      const message = 'valid, older';
      await insertChallenge(userId, signer.address, message, { createdAt: '2026-01-01T00:00:00Z' });
      await insertChallenge(userId, signer.address, 'used, newer', { createdAt: '2026-01-02T00:00:00Z', usedAt: '2026-01-02T00:01:00Z' });
      await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(message))).resolves.toMatchObject({ chain: 'INJECTIVE' });
    });

    it('verify prefers the valid challenge over a newer expired one', async () => {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      const message = 'valid, older';
      await insertChallenge(userId, signer.address, message, { createdAt: '2026-01-01T00:00:00Z' });
      await insertChallenge(userId, signer.address, 'expired, newer', { createdAt: '2026-01-02T00:00:00Z', expiresIn: '-1 minute' });
      await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(message))).resolves.toMatchObject({ chain: 'INJECTIVE' });
    });

    it('with several valid challenges verify checks the newest message, not the oldest', async () => {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      await insertChallenge(userId, signer.address, 'older', { createdAt: '2026-01-01T00:00:00Z' });
      await insertChallenge(userId, signer.address, 'newer', { createdAt: '2026-01-02T00:00:00Z' });
      await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage('newer'))).resolves.toMatchObject({ chain: 'INJECTIVE' });
    });
  });

  describe('agent wallet conflict edge cases (survivors of the K mutants)', () => {
    async function linkWithAgentWallet(agentWallet: (signerInj: string) => string, deleted = false) {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      await db.query(
        `INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at, deleted_at)
         VALUES ($1, 'twin', $2, 'ACTIVE', now(), CASE WHEN $3::boolean THEN now() END)`,
        [userId, agentWallet(`inj1${signer.address.slice(2).toLowerCase()}`), deleted],
      );
      const challenge = await wallets.createChallenge(userId, signer.address);
      return wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message));
    }

    it('a soft-deleted agent on the same wallet does not block linking it', async () => {
      await expect(linkWithAgentWallet((inj) => inj, true)).resolves.toMatchObject({ chain: 'INJECTIVE' });
    });

    it('the comparison is case-insensitive: an upper-case INJ1 agent wallet still blocks', async () => {
      const signer = Wallet.createRandom();
      const userId = await createUser(db, { onboarded: false });
      await db.query(`INSERT INTO agent (owner_user_id, name, wallet_address, status, verified_at) VALUES ($1, 'twin', $2, 'ACTIVE', now())`,
        [userId, `inj1${signer.address.slice(2).toLowerCase()}`.toUpperCase()]);
      const challenge = await wallets.createChallenge(userId, signer.address);
      await expect(wallets.verifySignature(userId, signer.address, await signer.signMessage(challenge.message)))
        .rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
    });

    it('a malformed 0x agent wallet (cannot be converted) never blocks linking', async () => {
      await expect(linkWithAgentWallet(() => '0xnot-a-real-address')).resolves.toMatchObject({ chain: 'INJECTIVE' });
    });
  });

  describe('primary wallet predicate and wallet disconnection (survivors of the K mutants)', () => {
    it('myWallet ignores a connected wallet that is not primary', async () => {
      const userId = await createUser(db);
      await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, false, now())`, [userId, `inj1${Wallet.createRandom().address.slice(2).toLowerCase()}`]);
      await expect(wallets.myWallet(userId)).resolves.toBeNull();
    });

    it('disconnectAllWalletsOfUser disconnects only that user\'s connected wallets and keeps an earlier disconnected_at', async () => {
      const [leaving, staying] = [await createUser(db), await createUser(db)];
      const address = () => `inj1${Wallet.createRandom().address.slice(2).toLowerCase()}`;
      const insert = (userId: string, disconnectedAt: string | null) => db.query<{ id: string }>(
        `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at, disconnected_at) VALUES ($1, 'INJECTIVE', $2, $3, now(), $4) RETURNING id`,
        [userId, address(), disconnectedAt === null, disconnectedAt]);
      const connected = (await insert(leaving, null)).rows[0].id;
      const earlier = (await insert(leaving, '2020-01-01T00:00:00Z')).rows[0].id;
      const other = (await insert(staying, null)).rows[0].id;

      await db.tx((tx) => disconnectAllWalletsOfUser(tx, leaving));

      const rows = await db.query<{ id: string; disconnected_at: Date | null }>(`SELECT id, disconnected_at FROM wallet WHERE id = ANY($1::uuid[])`, [[connected, earlier, other]]);
      const byId = new Map(rows.rows.map((row) => [row.id, row.disconnected_at]));
      expect(byId.get(connected)).toBeInstanceOf(Date);
      expect(byId.get(earlier)?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
      expect(byId.get(other)).toBeNull();
    });
  });
});
