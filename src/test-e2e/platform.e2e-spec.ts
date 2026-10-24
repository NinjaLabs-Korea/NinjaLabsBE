import { createHash, randomBytes } from 'crypto';
import { describeDb } from '../test-db/describe-db';
import { getEthereumAddress, getInjectiveAddress } from './support/injective-sdk.stub';
import { E2eApp, FE_ORIGIN, PREVIEW_ORIGIN, startApp } from './support/harness';

// a. health · d. CORS · k. observability — the whole app over HTTP
describeDb('platform: health, CORS, observability (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp(); });
  afterAll(async () => e2e?.close());

  it('the sdk-ts stub produces the same inj1 addresses as @injectivelabs/sdk-ts (vectors taken from the real package)', () => {
    const vectors: Array<[string, string]> = [
      ['0x0000000000000000000000000000000000000001', 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgh'],
      ['0xAbCdEf0123456789abcdef0123456789ABCDEF01', 'inj140x77qfrg4ncn27dauqjx3t83x4ummcpuxkqxx'],
      ['0xffffffffffffffffffffffffffffffffffffffff', 'inj1llllllllllllllllllllllllllllllll4mk5j0'],
    ];
    for (const [evm, inj] of vectors) {
      expect(getInjectiveAddress(evm)).toBe(inj);
      expect(getEthereumAddress(inj)).toBe(evm.toLowerCase());
    }
    expect(() => getEthereumAddress('inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpyurwgx')).toThrow(/checksum/);
  });

  describe('a. GET /health', () => {
    it('200 {status:"ok", db:"up"} and no request log line (Railway polls it)', async () => {
      const before = e2e.linesFor('HTTP').length;
      const res = await e2e.get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', db: 'up' });
      expect(e2e.linesFor('HTTP').length).toBe(before);
    });

    it('503 with the same {status, db} shape when the pool cannot answer', async () => {
      const spy = jest.spyOn(e2e.db, 'query').mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' }));
      try {
        const res = await e2e.get('/health');
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ status: 'degraded', db: 'down' });
        expect(Object.keys(res.body).sort()).toEqual(['db', 'status']);
      } finally {
        spy.mockRestore();
      }
      expect((await e2e.get('/health')).body).toEqual({ status: 'ok', db: 'up' });
    });
  });

  describe('d. CORS', () => {
    it.each([FE_ORIGIN, PREVIEW_ORIGIN])('preflight from the allowed origin %s → ACAO echoes it + credentials', async (origin) => {
      const res = await e2e.request('OPTIONS', '/auth/refresh', {
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers['access-control-allow-methods'])).toMatch(/POST/);
    });

    it.each([
      'https://evil.example',
      'https://ninjalabsfe-evil-team.vercel.app', // the shared-hosting wildcard entry is rejected at boot
      'http://localhost:3001',
      'https://localhost:3000',
    ])('preflight from the disallowed origin %s → no ACAO header', async (origin) => {
      const res = await e2e.request('OPTIONS', '/auth/refresh', { headers: { origin, 'access-control-request-method': 'POST' } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('a request without Origin proceeds (server-to-server / curl) and a simple GET from an allowed origin carries ACAO', async () => {
      const bare = await e2e.get('/bounties');
      expect(bare.status).toBe(200);
      expect(bare.headers['access-control-allow-origin']).toBeUndefined();
      const allowed = await e2e.get('/bounties', { headers: { origin: FE_ORIGIN } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers['access-control-allow-origin']).toBe(FE_ORIGIN);
      const denied = await e2e.get('/bounties', { headers: { origin: 'https://evil.example' } });
      expect(denied.status).toBe(200); // CORS is enforced by the browser; the server only withholds ACAO
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('the rejected shared-hosting wildcard is reported once at boot', () => {
      expect(e2e.logs.some((l) => l.level === 'error' && /ninjalabsfe-\*-team\.vercel\.app.*REJECTED/.test(l.message))).toBe(true);
    });
  });

  describe('k. observability', () => {
    it('request log line: "<METHOD> <path> <status> <n>ms" — path only, no query string', async () => {
      await e2e.get('/notices?page=1&pageSize=5&category=EVENT');
      const line = e2e.linesFor('HTTP').find((l) => l.startsWith('GET /notices '));
      expect(line).toMatch(/^GET \/notices 200 \d+ms$/);
    });

    it('handlers that write the response themselves (@Res redirect) log the status actually sent, once', async () => {
      const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
      const res = await e2e.get(`/auth/google?codeChallenge=${challenge}`);
      expect(res.status).toBe(302);
      await new Promise((resolve) => setImmediate(resolve));
      const lines = e2e.linesFor('HTTP').filter((l) => l.startsWith('GET /auth/google '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^GET \/auth\/google 302 \d+ms$/);
    });

    it('a 5xx logs exactly one HttpException line (method, path, status, error) — no body, headers or query; the response stays Nest-shaped', async () => {
      const spy = jest.spyOn(e2e.db, 'query').mockRejectedValueOnce(new TypeError('pool exploded'));
      const before = e2e.linesFor('HttpException').length;
      try {
        const res = await e2e.request('GET', '/members?probe=query-value', {
          headers: { authorization: 'Bearer header-value-token', cookie: 'sid=cookie-value' },
        });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      } finally {
        spy.mockRestore();
      }
      const lines = e2e.linesFor('HttpException').slice(before);
      expect(lines).toEqual(['GET /members 500 TypeError: pool exploded']);
      const all = e2e.logs.map((l) => l.message).join('\n');
      for (const leaked of ['header-value-token', 'cookie-value', 'query-value']) expect(all).not.toContain(leaked);
      expect(e2e.linesFor('HTTP').some((l) => /^GET \/members 500 \d+ms$/.test(l))).toBe(true);
    });

    it('4xx are not logged as errors by the filter', async () => {
      const before = e2e.linesFor('HttpException').length;
      expect((await e2e.get('/bounties/not-a-uuid')).status).toBe(400);
      expect((await e2e.get('/auth/me')).status).toBe(401);
      expect(e2e.linesFor('HttpException').length).toBe(before);
    });
  });
});
