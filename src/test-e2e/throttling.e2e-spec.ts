import { Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, Session, startApp } from './support/harness';

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

  it('/auth/refresh keeps the coarse per-IP limit (global 120/min): fresh tokens every call still hit 429 on the 121st; spoofed X-Forwarded-For prefixes do not open a new bucket', async () => {
    const statuses = await burst(120, (i) => e2e.post('/auth/refresh', { refreshToken: unknownToken(`ip${i}`) }, { ip: `198.51.100.${i % 250}, 203.0.113.50` }));
    expect(statuses.every((s) => s === 401)).toBe(true);
    const over = await e2e.post('/auth/refresh', { refreshToken: unknownToken('over') }, { ip: '198.51.100.251, 203.0.113.50' });
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await e2e.post('/auth/refresh', { refreshToken: unknownToken('other-ip') }, { ip: '203.0.113.51' })).status).toBe(401);
  });

  it('the global limit is 120/min per IP (unsuffixed Retry-After), separate per IP', async () => {
    const statuses = await burst(120, () => e2e.get('/bounties?pageSize=1', { ip: '203.0.113.30' }));
    expect(statuses.every((s) => s === 200)).toBe(true);
    const over = await e2e.get('/bounties?pageSize=1', { ip: '203.0.113.30' });
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    expect((await e2e.get('/bounties?pageSize=1', { ip: '203.0.113.31' })).status).toBe(200);
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
      const owner = await e2e.login();
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
});
