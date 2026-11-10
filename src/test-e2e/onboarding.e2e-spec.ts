import { describeDb } from '../test-db/describe-db';
import { E2eApp, startApp } from './support/harness';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });

// f. onboarding - FE flow: Google login (step 3 = profile) → profile saved (step 4) → complete. The wallet step (2) is gone (BE PR2)
describeDb('onboarding over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  it('a first Google login starts at step 3 (profile); /auth/me keeps the wallet: null shim and the user has no wallet or NFT side effects', async () => {
    const session = await e2e.login();
    const me = await e2e.get('/auth/me', { token: session.accessToken });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ onboardingStep: 3, onboardingCompleted: false, wallet: null, nft: null });
    expect(Object.keys(me.body)).toContain('wallet'); // old FE codecs still read the key (removed in a later cleanup PR)
    expect((await e2e.db.query(`SELECT 1 FROM wallet WHERE user_id = $1`, [session.userId])).rowCount).toBe(0);
    expect((await e2e.db.query(`SELECT 1 FROM nft WHERE owner_user_id = $1`, [session.userId])).rowCount).toBe(0);
  });

  it('the removed wallet routes are 404 (BE PR2), signed in or not', async () => {
    const session = await e2e.login();
    const address = '0x0000000000000000000000000000000000000001';
    const routes: Array<['get' | 'post', string, object?]> = [
      ['post', '/wallets/challenge', { address }],
      ['post', '/wallets/verify', { address, signature: '0x00' }],
      ['get', '/wallets/me'],
      ['post', '/wallets/replacement/challenge', { currentAddress: address, newAddress: address }],
      ['post', '/wallets/replacement/verify', { challengeId: '00000000-0000-4000-8000-000000000000', currentSignature: 'a', newSignature: 'b' }],
    ];
    for (const [method, path, body] of routes) {
      for (const token of [session.accessToken, undefined]) {
        const res = method === 'get' ? await e2e.get(path, { token }) : await e2e.post(path, body, { token });
        expect([path, token ? 'signed-in' : 'anonymous', res.status]).toEqual([path, token ? 'signed-in' : 'anonymous', 404]);
      }
    }
  });

  it('the removed NFT job console routes are 404 (BE PR3), signed in or not', async () => {
    const session = await e2e.login();
    const jobId = '00000000-0000-4000-8000-000000000000';
    for (const token of [session.accessToken, undefined]) {
      const list = await e2e.get('/admin/nft-jobs', { token });
      const retry = await e2e.post(`/admin/nft-jobs/${jobId}/retry`, undefined, { token });
      expect([list.status, retry.status]).toEqual([404, 404]);
    }
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
      for (const staticLike of ['ninja.png', 'Ninja.JSON', 'a.b.woff2']) {
        expect((await save(staticLike)).body).toEqual(badRequest([expect.stringMatching(/^nickname must not end with a static file extension \(\.ico, \.png, /)]));
      }
      expect((await save('ninja.jsx')).status).toBe(201); // not in the FE proxy list
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

    it('duplicate tags collapse to a set → 201 (was 409 NICKNAME_TAKEN from the user_tag primary key)', async () => {
      const session = await e2e.login();
      const nickname = `Tags${Date.now().toString(36)}`;
      const res = await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV', 'DEV', 'DESIGN'] }, { token: session.accessToken });
      expect(res.status).toBe(201);
      expect([...(await e2e.get('/auth/me', { token: session.accessToken })).body.tags].sort()).toEqual(['DESIGN', 'DEV']);
    });
  });

  it('a public-profile lookup with CR/LF and a 2000-char nickname logs one capped failure line (no forged lines)', async () => {
    const forged = `ghost\r\n[onboarding] {"event":"forged"}${'x'.repeat(2000)}`;
    expect((await e2e.get(`/users/${encodeURIComponent(forged)}`)).status).toBe(404);
    const lines = e2e.linesFor('UsersController').filter((line) => line.includes('ghost'));
    expect(lines).toHaveLength(1); // failed only - no requested/succeeded lines on this hot public read
    expect(lines[0]).toMatch(/"rid":"[0-9a-f-]{36}"/);
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line.length).toBeLessThan(400);
    }
    const requestLine = e2e.linesFor('HTTP').find((line) => line.includes('ghost'))!;
    expect(requestLine.length).toBeLessThan(300);
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

    it('answers what POST /users/me/profile would accept: surrounding spaces are trimmed like the save, and names the save rejects are never "available"', async () => {
      const session = await e2e.login();
      const nickname = `Trim${Date.now().toString(36)}`;
      await e2e.post('/users/me/profile', { nickname, bio: 'b', tags: ['DEV'] }, { token: session.accessToken });
      const check = (value: string) => e2e.get(`/users/check-nickname?nickname=${encodeURIComponent(value)}`);
      // the save trims, so " <taken> " collides on save → must not be reported available
      expect((await check(` ${nickname} `)).body).toEqual({ available: false });
      for (const invalid of ['', 'a', '.ninja', 'has space', 'n'.repeat(51), 'ninja.png', 'Ninja.Js', 'x.WEBP']) {
        expect((await check(invalid)).body).toEqual({ available: false });
      }
      expect((await e2e.get('/users/check-nickname')).body).toEqual({ available: false });
      // a repeated query parameter arrives as an array - answered, never a 500
      const repeated = await e2e.get(`/users/check-nickname?nickname=${nickname}&nickname=other`);
      expect(repeated.status).toBe(200);
      expect(repeated.body).toEqual({ available: false });
    });
  });
});
