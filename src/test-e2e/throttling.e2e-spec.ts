import { Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, Session, startApp } from './support/harness';

/** 공개 읽기(600/min)가 아닌 라우트 — 전역 120/min을 검증할 때 쓴다 (인증 없이 401) */
const NON_PUBLIC_ROUTE = '/wallets/me';
const TOO_MANY = { statusCode: 429, message: 'ThrottlerException: Too Many Requests' };

// c. throttling — in-memory throttler storage per app instance; trust proxy 1 → the last X-Forwarded-For hop is the client
describeDb('throttling over HTTP (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  async function burst(count: number, send: (i: number) => Promise<{ status: number }>) {
    const statuses: number[] = [];
    for (let i = 0; i < count; i++) statuses.push((await send(i)).status);
    return statuses;
  }

  const unknownToken = (label: string) => `unknown-${label}-${Math.random().toString(36).slice(2)}`;
  const code43 = (c: string) => c.repeat(43);
  const verifier = 'v'.repeat(43);

  it('the global IP limit keys IPv6 clients by /64: rotating addresses inside one prefix does not escape the 120/min bucket', async () => {
    const prefix = '2001:db8:e2e:7';
    const statuses = await burst(121, (i) => e2e.get(NON_PUBLIC_ROUTE, { ip: `${prefix}:${i.toString(16)}::${i + 1}` }));
    expect(statuses.slice(0, 120)).toEqual(Array(120).fill(401));
    expect(statuses[120]).toBe(429);
    // a neighbouring /64 is a different subscriber and is untouched
    expect((await e2e.get(NON_PUBLIC_ROUTE, { ip: '2001:db8:e2e:8::1' })).status).toBe(401);
  });

  it('/auth/refresh: the 11th call in a minute with the same refresh token is 429 (Retry-After-auth-token) even from changing IPs', async () => {
    const token = unknownToken('same');
    const statuses = await burst(10, (i) => e2e.post('/auth/refresh', { refreshToken: token }, { ip: `203.0.113.${10 + i}` }));
    expect(statuses).toEqual(Array(10).fill(401));
    const eleventh = await e2e.post('/auth/refresh', { refreshToken: token }, { ip: '203.0.113.99' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual(TOO_MANY);
    expect(Number(eleventh.headers['retry-after-auth-token'])).toBeGreaterThan(0);
    expect(eleventh.headers['retry-after']).toBeUndefined(); // the IP bucket is not what tripped
  });

  it('/auth/refresh: two tokens from the same IP (users behind the Vercel proxy egress) are not limited together', async () => {
    const ip = '203.0.113.40';
    const [a, b] = [unknownToken('a'), unknownToken('b')];
    expect(await burst(10, () => e2e.post('/auth/refresh', { refreshToken: a }, { ip }))).toEqual(Array(10).fill(401));
    expect(await burst(10, () => e2e.post('/auth/refresh', { refreshToken: b }, { ip }))).toEqual(Array(10).fill(401));
    expect((await e2e.post('/auth/refresh', { refreshToken: a }, { ip })).status).toBe(429);
    const third = await e2e.post('/auth/refresh', { refreshToken: unknownToken('c') }, { ip });
    expect(third.status).toBe(401);
    expect(third.headers['x-ratelimit-limit-auth-token']).toBe('10');
  });

  it('/auth/refresh in cookie mode: the ninja_rt cookie keys the bucket (body {} — no token in the body)', async () => {
    const ip = '203.0.113.41';
    const cookie = (t: string) => ({ ip, headers: { 'x-ninja-session': 'cookie', cookie: `ninja_rt=${t}` } });
    const [a, b] = [unknownToken('ca'), unknownToken('cb')];
    expect(await burst(10, () => e2e.post('/auth/refresh', {}, cookie(a)))).toEqual(Array(10).fill(401));
    expect((await e2e.post('/auth/refresh', {}, cookie(a))).status).toBe(429);
    expect((await e2e.post('/auth/refresh', {}, cookie(b))).status).toBe(401);
  });

  it('/auth/exchange is keyed by the login-code hash: the 11th try of one code is 429, another code from the same IP is not', async () => {
    const ip = '203.0.113.42';
    expect(await burst(10, () => e2e.post('/auth/exchange', { code: code43('a'), codeVerifier: verifier }, { ip }))).toEqual(Array(10).fill(401));
    const eleventh = await e2e.post('/auth/exchange', { code: code43('a'), codeVerifier: verifier }, { ip });
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers['retry-after-auth-token'])).toBeGreaterThan(0);
    expect((await e2e.post('/auth/exchange', { code: code43('b'), codeVerifier: verifier }, { ip })).status).toBe(401);
  });

  it('/auth/refresh: the per-IP limit is raised to 600/min (Vercel egress IPs carry many users): fresh tokens every call hit 429 only on the 601st; spoofed X-Forwarded-For prefixes do not open a new bucket', async () => {
    const statuses = await burst(600, (i) => e2e.post('/auth/refresh', { refreshToken: unknownToken(`ip${i}`) }, { ip: `198.51.100.${i % 250}, 203.0.113.50` }));
    expect(statuses.every((s) => s === 401)).toBe(true);
    const over = await e2e.post('/auth/refresh', { refreshToken: unknownToken('over') }, { ip: '198.51.100.251, 203.0.113.50' });
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(over.headers['retry-after-auth-token']).toBeUndefined(); // the IP bucket tripped, not a token bucket
    expect((await e2e.post('/auth/refresh', { refreshToken: unknownToken('other-ip') }, { ip: '203.0.113.51' })).status).toBe(401);
  });

  it('/auth/exchange: the per-IP limit is 600/min too — 121+ distinct codes from one IP are not 429 (they 401)', async () => {
    const ip = '203.0.113.52';
    const codes = (i: number) => code43('e').slice(0, 40) + String(i).padStart(3, '0');
    const statuses = await burst(150, (i) => e2e.post('/auth/exchange', { code: codes(i), codeVerifier: verifier }, { ip }));
    expect(statuses).toEqual(Array(150).fill(401));
    const last = await e2e.post('/auth/exchange', { code: codes(150), codeVerifier: verifier }, { ip });
    expect(last.status).toBe(401);
    expect(last.headers['x-ratelimit-limit']).toBe('600');
  });

  it('/auth/logout: the 11th call in a minute with the same refresh token is 429 (Retry-After-auth-token) even from changing IPs; another token from the same IP is not', async () => {
    const token = unknownToken('logout');
    const statuses = await burst(10, (i) => e2e.post('/auth/logout', { refreshToken: token }, { ip: `203.0.113.${110 + i}` }));
    expect(statuses).toEqual(Array(10).fill(204));
    const eleventh = await e2e.post('/auth/logout', { refreshToken: token }, { ip: '203.0.113.120' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual(TOO_MANY);
    expect(Number(eleventh.headers['retry-after-auth-token'])).toBeGreaterThan(0);
    expect(eleventh.headers['retry-after']).toBeUndefined(); // the IP bucket is not what tripped
    const other = await e2e.post('/auth/logout', { refreshToken: unknownToken('logout-b') }, { ip: '203.0.113.120' });
    expect(other.status).toBe(204);
    expect(other.headers['x-ratelimit-limit-auth-token']).toBe('10');
  });

  it('/auth/logout: the per-IP limit is 600/min (Vercel egress IPs carry many users) — 121+ logouts from one IP are not 429; a token-less cookie-mode logout skips the token bucket', async () => {
    const ip = '203.0.113.54';
    const statuses = await burst(130, (i) => e2e.post('/auth/logout', { refreshToken: unknownToken(`lo${i}`) }, { ip }));
    expect(statuses).toEqual(Array(130).fill(204));
    // no token → nothing to revoke: not keyed by the shared IP at 10/min (that would 429 every user behind the egress IP)
    const bare = await burst(15, () => e2e.post('/auth/logout', {}, { ip, headers: { 'x-ninja-session': 'cookie' } }));
    expect(bare).toEqual(Array(15).fill(204));
    const last = await e2e.post('/auth/logout', {}, { ip, headers: { 'x-ninja-session': 'cookie' } });
    expect(last.headers['x-ratelimit-limit']).toBe('600');
    expect(last.headers['x-ratelimit-limit-auth-token']).toBeUndefined();
  });

  it('/auth/refresh and /auth/exchange without a credential skip the token bucket: 15 cookie-less refreshes / body-less exchanges from one IP stay 401/400, not 429', async () => {
    const ip = '203.0.113.55';
    expect(await burst(15, () => e2e.post('/auth/refresh', {}, { ip, headers: { 'x-ninja-session': 'cookie' } }))).toEqual(Array(15).fill(401));
    expect(await burst(15, () => e2e.post('/auth/exchange', {}, { ip }))).toEqual(Array(15).fill(400));
    const last = await e2e.post('/auth/refresh', {}, { ip, headers: { 'x-ninja-session': 'cookie' } });
    expect(last.headers['x-ratelimit-limit-auth-token']).toBeUndefined();
  });

  it('other routes keep 120/min per IP even after the auth routes were used from that IP', async () => {
    const ip = '203.0.113.53';
    expect((await e2e.post('/auth/refresh', { refreshToken: unknownToken('pre') }, { ip })).headers['x-ratelimit-limit']).toBe('600');
    const first = await e2e.get(NON_PUBLIC_ROUTE, { ip });
    expect(first.headers['x-ratelimit-limit']).toBe('120');
    const statuses = await burst(119, () => e2e.get(NON_PUBLIC_ROUTE, { ip }));
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect((await e2e.get(NON_PUBLIC_ROUTE, { ip })).status).toBe(429);
  });

  it('the global limit is 120/min per IP (unsuffixed Retry-After), separate per IP', async () => {
    const statuses = await burst(120, () => e2e.get(NON_PUBLIC_ROUTE, { ip: '203.0.113.30' }));
    expect(statuses.every((s) => s === 401)).toBe(true);
    const over = await e2e.get(NON_PUBLIC_ROUTE, { ip: '203.0.113.30' });
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    expect((await e2e.get(NON_PUBLIC_ROUTE, { ip: '203.0.113.31' })).status).toBe(401);
  });

  it('write routes keep 120/min: the 121st POST /wallets/challenge from one IP is 429', async () => {
    const ip = '203.0.113.60';
    const statuses = await burst(120, () => e2e.post('/wallets/challenge', {}, { ip }));
    expect(statuses.every((s) => s !== 429)).toBe(true);
    expect((await e2e.post('/wallets/challenge', {}, { ip })).status).toBe(429);
  });

  describe('public reads: 600/min per IP (Vercel SSR egress carries many users)', () => {
    const MEDIA_ID = '00000000-0000-4000-8000-000000000000';

    it('/bounties: request 121 is not 429, request 601 is; a spoofed X-Forwarded-For prefix does not open a new bucket', async () => {
      const real = '203.0.113.61';
      const statuses = await burst(600, (i) => e2e.get('/bounties?pageSize=1', { ip: `198.51.100.${i % 250}, ${real}` }));
      expect(statuses.every((s) => s === 200)).toBe(true);
      const over = await e2e.get('/bounties?pageSize=1', { ip: `198.51.100.251, ${real}` });
      expect(over.status).toBe(429);
      expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
      expect((await e2e.get('/bounties?pageSize=1', { ip: '203.0.113.62' })).status).toBe(200);
    });

    it('/media/:id: request 121 is not 429, request 601 is', async () => {
      const ip = '203.0.113.63';
      const statuses = await burst(600, () => e2e.get(`/media/${MEDIA_ID}`, { ip }));
      expect(statuses.every((s) => s === 404)).toBe(true);
      expect((await e2e.get(`/media/${MEDIA_ID}`, { ip })).status).toBe(429);
    });
  });

  describe('Agent API', () => {
    async function agentKey(owner: Session): Promise<string> {
      const signer = Wallet.createRandom();
      const registered = await e2e.post('/agents', { name: 'rate-bot', walletAddress: signer.address }, { token: owner.accessToken });
      expect(registered.status).toBe(201);
      const signature = await signer.signMessage(registered.body.verificationMessage);
      const verified = await e2e.post(`/agents/${registered.body.agentId}/verify`, { signature }, { token: owner.accessToken });
      expect(verified.status).toBe(201);
      e2e.trackTokens(verified.body);
      return verified.body.apiKey;
    }

    it('the 61st call in a minute with one key is 429 with only Retry-After-agent-api; the budget is per key, not per IP', async () => {
      const owner = await e2e.loginOnboarded();
      const key = await agentKey(owner);
      const other = await agentKey(owner);
      // different client IPs every call: the per-IP global limit cannot be what trips
      const statuses = await burst(60, () => e2e.get('/agent-api/v1/me', { token: key }));
      expect(statuses).toEqual(Array(60).fill(200));
      const sixtyFirst = await e2e.get('/agent-api/v1/me', { token: key });
      expect(sixtyFirst.status).toBe(429);
      expect(sixtyFirst.body).toEqual(TOO_MANY);
      expect(Number(sixtyFirst.headers['retry-after-agent-api'])).toBeGreaterThan(0);
      expect(sixtyFirst.headers['retry-after']).toBeUndefined();
      expect(sixtyFirst.headers['x-ratelimit-limit-agent-api']).toBeUndefined();

      const fresh = await e2e.get('/agent-api/v1/me', { token: other });
      expect(fresh.status).toBe(200);
      expect(fresh.headers['x-ratelimit-limit-agent-api']).toBe('60');
      expect(fresh.body).toMatchObject({ ownerUserId: owner.userId, name: 'rate-bot', status: 'ACTIVE' });
    });

    it('an unauthenticated Agent API call is 401 before the per-key throttler', async () => {
      const res = await e2e.get('/agent-api/v1/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ statusCode: 401, error: 'Unauthorized', message: 'MISSING_AGENT_API_KEY' });
      expect((await e2e.get('/agent-api/v1/me', { token: 'nj_not-a-real-key-at-all' })).body.message).toBe('INVALID_AGENT_API_KEY');
    });
  });

  // The browser navigates to these two routes (not fetch): a JSON 429 would be the page the user sees.
  describe('browser-navigated Google routes', () => {
    it.each([
      ['/auth/google?codeChallenge=' + 'c'.repeat(43), '203.0.113.150'],
      ['/auth/google/callback?error=access_denied', '203.0.113.151'],
    ])('%s: the 21st call in a minute is a 302 to the FE callback with TOO_MANY_REQUESTS, not a JSON 429', async (path, ip) => {
      const statuses = await burst(21, () => e2e.get(path, { ip }));
      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(302));
      const throttled = await e2e.get(path, { ip });
      expect(throttled.status).toBe(302);
      expect(String(throttled.headers.location)).toMatch(/\/auth\/callback#error=TOO_MANY_REQUESTS$/);
      expect(throttled.headers['retry-after']).toBe('60');
      expect(throttled.headers['content-type'] ?? '').not.toContain('application/json');
    });
  });
});
