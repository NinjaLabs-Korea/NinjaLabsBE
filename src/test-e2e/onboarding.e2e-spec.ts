import { Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { getInjectiveAddress } from './support/injective-sdk.stub';
import { E2eApp, startApp, UUID } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

// f. onboarding — FE flow: Google login (step 2) → wallet (step 3) → profile (step 4) → complete
describeDb('onboarding over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  it('wallet challenge → real EIP-191 signature → inj1 wallet stored, parent mint job enqueued; a second verify is 409 WALLET_ALREADY_LINKED', async () => {
    const session = await e2e.login();
    const signer = Wallet.createRandom();

    // the FE sends the address exactly as the wallet reports it (checksummed 0x…)
    const challenge = await e2e.post('/wallets/challenge', { address: signer.address }, { token: session.accessToken });
    expect(challenge.status).toBe(201);
    expect(Object.keys(challenge.body).sort()).toEqual(['expires_at', 'id', 'message', 'nonce']);
    expect(challenge.body.message).toContain(`주소: ${signer.address}`);
    expect(challenge.body.message).toContain(`nonce: ${challenge.body.nonce}`);
    expect(new Date(challenge.body.expires_at).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);

    const forged = await e2e.post('/wallets/verify', { address: signer.address, signature: await Wallet.createRandom().signMessage(challenge.body.message) }, { token: session.accessToken });
    expect(forged.status).toBe(401);
    expect(forged.body.message).toBe('INVALID_SIGNATURE');

    const signature = await signer.signMessage(challenge.body.message);
    const verified = await e2e.post('/wallets/verify', { address: signer.address, signature }, { token: session.accessToken });
    expect(verified.status).toBe(201);
    const inj = getInjectiveAddress(signer.address);
    expect(inj).toMatch(/^inj1[02-9ac-hj-np-z]{38}$/);
    expect(verified.body).toEqual({ id: expect.stringMatching(UUID), chain: 'INJECTIVE', address: inj, verified_at: expect.any(String), created_at: expect.any(String) });
    expect((await e2e.get('/wallets/me', { token: session.accessToken })).body).toEqual(verified.body);

    const me = await e2e.get('/auth/me', { token: session.accessToken });
    expect(me.body).toMatchObject({ onboardingStep: 3, wallet: { address: inj, verifiedAt: expect.any(String) }, nft: { status: 'PENDING', tokenId: null } });
    const job = await e2e.db.query<{ job_type: string; status: string; idempotency_key: string; owner: string }>(
      `SELECT j.job_type, j.status, j.idempotency_key, w.address AS owner
         FROM nft_job j JOIN nft n ON n.id = j.nft_id JOIN wallet w ON w.id = n.owner_wallet_id
        WHERE n.owner_user_id = $1`, [session.userId]);
    expect(job.rows).toEqual([{ job_type: 'MINT_PARENT', status: 'PENDING', idempotency_key: `mint-parent:${session.userId}`, owner: inj }]);

    // replaying the consumed challenge
    expect((await e2e.post('/wallets/verify', { address: signer.address, signature }, { token: session.accessToken })).body.message).toBe('CHALLENGE_EXPIRED');

    // a second wallet for the same user
    const second = Wallet.createRandom();
    const c2 = await e2e.post('/wallets/challenge', { address: second.address }, { token: session.accessToken });
    const dup = await e2e.post('/wallets/verify', { address: second.address, signature: await second.signMessage(c2.body.message) }, { token: session.accessToken });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ statusCode: 409, error: 'Conflict', message: 'WALLET_ALREADY_LINKED' });

    // the same address for another account
    const other = await e2e.login();
    const c3 = await e2e.post('/wallets/challenge', { address: signer.address.toLowerCase() }, { token: other.accessToken });
    const taken = await e2e.post('/wallets/verify', { address: signer.address.toLowerCase(), signature: await signer.signMessage(c3.body.message) }, { token: other.accessToken });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toBe('WALLET_ALREADY_LINKED');
    const jobs = await e2e.db.query(`SELECT 1 FROM nft WHERE owner_user_id = $1`, [other.userId]);
    expect(jobs.rowCount).toBe(0); // rolled back with the wallet insert
  });

  it('wallet input errors: bad address 400 INVALID_INJECTIVE_ADDRESS, verify without challenge 400 CHALLENGE_NOT_FOUND, unauthenticated 401', async () => {
    const session = await e2e.login();
    for (const address of ['0x123', 'cosmos1abc', 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgx']) {
      const res = await e2e.post('/wallets/challenge', { address }, { token: session.accessToken });
      expect(res.status).toBe(400);
      expect(res.body).toEqual(badRequest('INVALID_INJECTIVE_ADDRESS'));
    }
    const signer = Wallet.createRandom();
    expect((await e2e.post('/wallets/verify', { address: signer.address, signature: '0x00' }, { token: session.accessToken })).body).toEqual(badRequest('CHALLENGE_NOT_FOUND'));
    expect((await e2e.post('/wallets/challenge', { address: signer.address })).status).toBe(401);
    expect((await e2e.post('/wallets/challenge', {}, { token: session.accessToken })).body).toEqual(badRequest(['address should not be empty']));
  });

  describe('profile', () => {
    it('saves the FE payload {nickname, bio, tags} → {ok:true}, trims the nickname, advances to step 4; complete-onboarding flips the flag', async () => {
      const session = await e2e.login();
      const nickname = `Ninja_${Date.now().toString(36)}`;
      const res = await e2e.post('/users/me/profile', { nickname: `  ${nickname} `, bio: 'I build on Injective', tags: ['DEV', 'DESIGN'] }, { token: session.accessToken });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
      const me = await e2e.get('/auth/me', { token: session.accessToken });
      expect(me.body).toMatchObject({ nickname, bio: 'I build on Injective', onboardingStep: 4, onboardingCompleted: false });
      expect([...me.body.tags].sort()).toEqual(['DESIGN', 'DEV']);

      const done = await e2e.post('/users/me/complete-onboarding', undefined, { token: session.accessToken });
      expect(done.status).toBe(201);
      expect(done.body).toEqual({ ok: true });
      expect((await e2e.get('/auth/me', { token: session.accessToken })).body.onboardingCompleted).toBe(true);
    });

    it('nickname rules and reserved words → 400 with the Nest message array the FE maps to fields', async () => {
      const session = await e2e.login();
      const save = (nickname: unknown) => e2e.post('/users/me/profile', { nickname, bio: 'bio', tags: ['DEV'] }, { token: session.accessToken });
      expect((await save('a')).body.message).toEqual(expect.arrayContaining(['nickname must be longer than or equal to 2 characters']));
      expect((await save('.ninja')).body).toEqual(badRequest([expect.stringMatching(/^nickname must match /)]));
      expect((await save('has space')).body.message).toEqual([expect.stringMatching(/^nickname must match /)]);
      expect((await save('n'.repeat(51))).body.message).toEqual(['nickname must be shorter than or equal to 50 characters']);
      for (const reserved of ['admin', 'Me', 'check-nickname', 'NEW', 'edit']) {
        expect((await save(reserved)).body).toEqual(badRequest(['nickname is a reserved word']));
      }
      expect((await save('닌자_빌더')).status).toBe(201); // unicode letters are allowed

      const missing = await e2e.post('/users/me/profile', { nickname: 'okname', bio: '', tags: [] }, { token: session.accessToken });
      expect(missing.status).toBe(400);
      expect(missing.body.message).toEqual(expect.arrayContaining(['bio should not be empty', 'tags should not be empty']));
      const badTag = await e2e.post('/users/me/profile', { nickname: 'okname', bio: 'b', tags: ['HACKER'] }, { token: session.accessToken });
      expect(badTag.body.message).toEqual(['each value in tags must be one of the following values: DEV, DESIGN, CONTENT, OTHER']);
    });

    it('a nickname taken by another active user (case-insensitive) → 409 NICKNAME_TAKEN', async () => {
      const first = await e2e.login();
      const nickname = `Dup${Date.now().toString(36)}`;
      expect((await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: first.accessToken })).status).toBe(201);
      const second = await e2e.login();
      const res = await e2e.post('/users/me/profile', { nickname: nickname.toUpperCase(), bio: 'b', tags: ['DEV'] }, { token: second.accessToken });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', message: 'NICKNAME_TAKEN' });
      // the owner can re-save their own nickname (profile edit)
      expect((await e2e.post('/users/me/profile', { nickname, bio: 'edited', tags: ['CONTENT'] }, { token: first.accessToken })).status).toBe(201);
    });
  });

  describe('GET /users/check-nickname', () => {
    it('available / taken (case-insensitive) / reserved', async () => {
      const session = await e2e.login();
      const nickname = `Chk${Date.now().toString(36)}`;
      const check = (value: string) => e2e.get(`/users/check-nickname?nickname=${encodeURIComponent(value)}`);
      expect((await check(nickname)).body).toEqual({ available: true });
      await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: session.accessToken });
      expect((await check(nickname)).body).toEqual({ available: false });
      expect((await check(nickname.toLowerCase())).body).toEqual({ available: false });
      expect((await check('Admin')).body).toEqual({ available: false });
    });

    it.failing('answers what POST /users/me/profile would accept: surrounding spaces are trimmed like the save, and names the save rejects are never "available"', async () => {
      const session = await e2e.login();
      const nickname = `Trim${Date.now().toString(36)}`;
      await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: session.accessToken });
      const check = (value: string) => e2e.get(`/users/check-nickname?nickname=${encodeURIComponent(value)}`);
      // the save trims, so " <taken> " collides on save → must not be reported available
      expect((await check(` ${nickname} `)).body).toEqual({ available: false });
      for (const invalid of ['', 'a', '.ninja', 'has space', 'n'.repeat(51)]) {
        expect((await check(invalid)).body).toEqual({ available: false });
      }
      expect((await e2e.get('/users/check-nickname')).body).toEqual({ available: false });
      // a repeated query parameter arrives as an array — answered, never a 500
      const repeated = await e2e.get(`/users/check-nickname?nickname=${nickname}&nickname=other`);
      expect(repeated.status).toBe(200);
      expect(repeated.body).toEqual({ available: false });
    });
  });
});
