import { describeDb } from '../test-db/describe-db';
import { E2eApp, FE_ORIGIN, PREVIEW_ORIGIN, randomIp, startApp } from './support/harness';

const TURNSTILE_SECRET = '0x4AAAAAAA-e2e-turnstile-secret';

// Cloudflare Turnstile on sign-in — TURNSTILE_SECRET_KEY set, siteverify faked at the fetch edge (support/fakes.ts FakeTurnstile)
describeDb('turnstile on GET /auth/google (e2e)', () => {
  let e2e: E2eApp;
  beforeAll(async () => { e2e = await startApp({ TURNSTILE_SECRET_KEY: TURNSTILE_SECRET }); });
  afterAll(async () => e2e?.close());

  const start = (params: Record<string, string>, ip = randomIp()) =>
    e2e.get(`/auth/google?${new URLSearchParams({ codeChallenge: E2eApp.pkce().challenge, ...params })}`, { ip });

  /** A refused start is a 302 to the FE callback (the route is a top-level navigation — raw JSON would strand the user), never to Google */
  const expectBackToFe = (res: { status: number; headers: Record<string, unknown> }, code: string) => {
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${FE_ORIGIN}/auth/callback#error=${code}`);
  };

  it('without a token → #error=TURNSTILE_FAILED on the FE callback, and no siteverify call', async () => {
    const before = e2e.turnstile.requests.length;
    const res = await start({});
    expectBackToFe(res, 'TURNSTILE_FAILED');
    expect(e2e.turnstile.requests.length).toBe(before);
  });

  it('a forged token → #error=TURNSTILE_FAILED after siteverify; the secret and client IP are sent', async () => {
    const ip = randomIp();
    const res = await start({ turnstileToken: 'forged' }, ip);
    expectBackToFe(res, 'TURNSTILE_FAILED');
    const sent = e2e.turnstile.requests[e2e.turnstile.requests.length - 1];
    expect(Object.fromEntries(sent)).toEqual({ secret: TURNSTILE_SECRET, response: 'forged', remoteip: ip });
  });

  it('a valid token → 302 to Google; replaying the same token → #error=TURNSTILE_FAILED (single use)', async () => {
    const token = e2e.turnstile.issueToken();
    const ok = await start({ turnstileToken: token });
    expect(ok.status).toBe(302);
    expect(String(ok.headers.location)).toMatch(/^https:\/\/accounts\.google\.com\//);
    const replay = await start({ turnstileToken: token });
    expectBackToFe(replay, 'TURNSTILE_FAILED');
  });

  it.each([
    ['another site using the same sitekey', { hostname: 'evil.example' }],
    ['a lookalike of the FE host', { hostname: 'localhost.evil.example' }],
    ['a widget rendered with another action', { action: 'signup' }],
    ['a widget without an action', { action: '' }],
  ])('a valid token from %s → 400 TURNSTILE_FAILED, no redirect', async (_label, widget) => {
    const res = await start({ turnstileToken: e2e.turnstile.issueToken(widget) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ statusCode: 400, error: 'Bad Request', message: 'TURNSTILE_FAILED' });
    expect(res.headers.location).toBeUndefined();
  });

  it('a token rendered on an allowed preview origin (AUTH_ALLOWED_REDIRECT_ORIGINS) → 302', async () => {
    const res = await start({ turnstileToken: e2e.turnstile.issueToken({ hostname: new URL(PREVIEW_ORIGIN).hostname }) });
    expect(res.status).toBe(302);
  });

  it('siteverify unreachable → #error=TURNSTILE_UNAVAILABLE', async () => {
    e2e.turnstile.outage = true;
    try {
      const res = await start({ turnstileToken: e2e.turnstile.issueToken() });
      expectBackToFe(res, 'TURNSTILE_UNAVAILABLE');
    } finally {
      e2e.turnstile.outage = false;
    }
  });

  it('full login still works end to end with a widget token (harness login passes one)', async () => {
    const session = await e2e.login();
    expect(session.accessToken).toBeTruthy();
    const me = await e2e.get('/auth/me', { token: session.accessToken });
    expect(me.status).toBe(200);
  });
});
