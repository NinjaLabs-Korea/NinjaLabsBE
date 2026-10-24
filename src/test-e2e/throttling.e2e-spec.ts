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

  it('/auth/refresh: the 11th call in a minute from one client IP is 429; another IP has its own bucket', async () => {
    const statuses = await burst(10, () => e2e.post('/auth/refresh', { refreshToken: 'unknown' }, { ip: '203.0.113.10' }));
    expect(statuses).toEqual(Array(10).fill(401));
    const eleventh = await e2e.post('/auth/refresh', { refreshToken: 'unknown' }, { ip: '203.0.113.10' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual(TOO_MANY);
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);

    expect((await e2e.post('/auth/refresh', { refreshToken: 'unknown' }, { ip: '203.0.113.11' })).status).toBe(401);
  });

  it('spoofing extra X-Forwarded-For entries in front of the proxy-appended hop does not open a new bucket', async () => {
    const statuses = await burst(11, (i) => e2e.post('/auth/refresh', { refreshToken: 'unknown' }, { ip: `198.51.100.${i}, 203.0.113.20` }));
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
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
