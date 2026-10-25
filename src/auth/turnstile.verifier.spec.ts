import { BadRequestException, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { TURNSTILE_SITEVERIFY_URL, TURNSTILE_TIMEOUT_MS, TurnstileVerifier } from './turnstile.verifier';

const SECRET = '0x4AAAAAAA-turnstile-secret-test';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

function verifierWith(env: Record<string, string | undefined>) {
  return new TurnstileVerifier({ get: (key: string) => env[key] } as never);
}

/** 로컬 FE(AUTH_SUCCESS_REDIRECT 미설정 → http://localhost:3000/)의 login 위젯이 낸 토큰의 siteverify 성공 응답 */
const OK = { success: true, 'error-codes': [], hostname: 'localhost', action: 'login' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('TurnstileVerifier', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('is disabled and skips verification without TURNSTILE_SECRET_KEY (blank counts as unset)', async () => {
    for (const secret of [undefined, '', '   ']) {
      const verifier = verifierWith({ TURNSTILE_SECRET_KEY: secret });
      expect(verifier.enabled).toBe(false);
      await expect(verifier.verify(undefined, '10.0.0.1')).resolves.toBeUndefined();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('warns once at boot in production when the secret is unset, and stays quiet otherwise', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    verifierWith({ NODE_ENV: 'production' }).onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('TURNSTILE_SECRET_KEY is not set');

    warn.mockClear();
    verifierWith({ NODE_ENV: 'development' }).onModuleInit();
    verifierWith({ NODE_ENV: 'production', TURNSTILE_SECRET_KEY: SECRET }).onModuleInit();
    expect(warn).not.toHaveBeenCalled();
  });

  it('posts secret, response and remoteip as a form to siteverify with a 5 s abort signal, and passes on success:true', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK));
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    await expect(verifierWith({ TURNSTILE_SECRET_KEY: SECRET }).verify(TOKEN, '203.0.113.7')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ secret: SECRET, response: TOKEN, remoteip: '203.0.113.7' });
    expect(timeout).toHaveBeenCalledWith(TURNSTILE_TIMEOUT_MS);
    expect(TURNSTILE_TIMEOUT_MS).toBe(5_000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits remoteip when the request IP is unknown', async () => {
    fetchMock.mockResolvedValue(jsonResponse(OK));
    await verifierWith({ TURNSTILE_SECRET_KEY: SECRET }).verify(TOKEN, undefined);
    const body = new URLSearchParams(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.has('remoteip')).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['over 2048 chars', 'x'.repeat(2049)],
  ])('rejects a %s token with 400 TURNSTILE_FAILED without calling siteverify', async (_label, token) => {
    const err = await verifierWith({ TURNSTILE_SECRET_KEY: SECRET }).verify(token, '10.0.0.1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe('TURNSTILE_FAILED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [['invalid-input-response']],
    [['timeout-or-duplicate']],
    [[]],
  ])('maps success:false with error-codes %j to 400 TURNSTILE_FAILED', async (codes) => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, 'error-codes': codes }));
    await expect(verifierWith({ TURNSTILE_SECRET_KEY: SECRET }).verify(TOKEN, '10.0.0.1')).rejects.toMatchObject({
      status: 400, message: 'TURNSTILE_FAILED',
    });
  });

  it.each([
    ['a network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['an HTTP 502', () => Promise.resolve(new Response('bad gateway', { status: 502 }))],
    ['a non-JSON body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['an invalid secret', () => Promise.resolve(jsonResponse({ success: false, 'error-codes': ['invalid-input-secret'] }))],
    ['a Cloudflare internal-error', () => Promise.resolve(jsonResponse({ success: false, 'error-codes': ['internal-error'] }))],
  ])('maps %s to 503 TURNSTILE_UNAVAILABLE', async (_label, impl) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(impl);
    const err = await verifierWith({ TURNSTILE_SECRET_KEY: SECRET }).verify(TOKEN, '10.0.0.1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toBe('TURNSTILE_UNAVAILABLE');
  });

  describe('hostname and action binding', () => {
    const env = {
      TURNSTILE_SECRET_KEY: SECRET,
      AUTH_SUCCESS_REDIRECT: 'https://ninjalabsfe.vercel.app/',
      AUTH_ALLOWED_REDIRECT_ORIGINS: 'https://ninjalabsfe-git-develop-team.vercel.app, https://preview-*.ninjalabs.xyz',
    };
    const verifyWith = (body: Record<string, unknown>) => {
      fetchMock.mockResolvedValue(jsonResponse({ success: true, 'error-codes': [], ...body }));
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      return verifierWith(env).verify(TOKEN, '10.0.0.1');
    };

    it.each([
      ['the AUTH_SUCCESS_REDIRECT host', 'ninjalabsfe.vercel.app'],
      ['an exact AUTH_ALLOWED_REDIRECT_ORIGINS host', 'ninjalabsfe-git-develop-team.vercel.app'],
      ['a wildcard AUTH_ALLOWED_REDIRECT_ORIGINS host', 'preview-42.ninjalabs.xyz'],
      ['an upper-case host', 'NinjaLabsFE.Vercel.App'],
    ])('passes a login-action token rendered on %s', async (_label, hostname) => {
      await expect(verifyWith({ hostname, action: 'login' })).resolves.toBeUndefined();
    });

    it.each([
      ['a foreign host', { hostname: 'evil.example', action: 'login' }],
      ['a suffix lookalike', { hostname: 'ninjalabsfe.vercel.app.evil.example', action: 'login' }],
      ['another Vercel project', { hostname: 'ninjalabsfe-evil.vercel.app', action: 'login' }],
      ['no hostname', { action: 'login' }],
      ['a non-string hostname', { hostname: ['ninjalabsfe.vercel.app'], action: 'login' }],
      ['another action', { hostname: 'ninjalabsfe.vercel.app', action: 'signup' }],
      ['an empty action', { hostname: 'ninjalabsfe.vercel.app', action: '' }],
      ['no action', { hostname: 'ninjalabsfe.vercel.app' }],
    ])('rejects a success:true token from %s with 400 TURNSTILE_FAILED', async (_label, body) => {
      await expect(verifyWith(body)).rejects.toMatchObject({ status: 400, message: 'TURNSTILE_FAILED' });
    });

    it('logs the mismatch with CR/LF escaped, without the token', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      fetchMock.mockResolvedValue(jsonResponse({ success: true, hostname: 'evil.example\r\nFAKE', action: 'login' }));
      await verifierWith(env).verify(TOKEN, '10.0.0.1').catch(() => undefined);
      const line = String(log.mock.calls[0][0]);
      expect(line).toContain('hostname/action mismatch');
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).not.toContain(TOKEN);
    });
  });

  it('never logs the token or the secret', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => { lines.push(String(message)); });
    }
    const verifier = verifierWith({ TURNSTILE_SECRET_KEY: SECRET });
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
    await verifier.verify(TOKEN, '10.0.0.1').catch(() => undefined);
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${TURNSTILE_SITEVERIFY_URL}`));
    await verifier.verify(TOKEN, '10.0.0.1').catch(() => undefined);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('AuthController GET /auth/google with Turnstile', () => {
  function setup(enabled: boolean, verify: jest.Mock = jest.fn(async () => undefined)) {
    const auth = {
      issueOauthState: jest.fn(async () => 'state'),
      buildGoogleAuthUrl: jest.fn(() => 'https://accounts.google.com/x'),
    };
    const controller = new AuthController(auth as never, { get: () => undefined } as never, { enabled, verify } as never);
    const res = { redirect: jest.fn() };
    const req = { ip: '203.0.113.7', headers: {} } as never;
    return { auth, controller, res, req, verify };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('verifies the token with the client IP before issuing state, then redirects', async () => {
    const s = setup(true);
    await s.controller.googleRedirect(undefined, undefined, 'c'.repeat(43), TOKEN, s.req, s.res as never);
    expect(s.verify).toHaveBeenCalledWith(TOKEN, '203.0.113.7');
    expect(s.verify.mock.invocationCallOrder[0]).toBeLessThan(s.auth.issueOauthState.mock.invocationCallOrder[0]);
    expect(s.res.redirect).toHaveBeenCalledWith('https://accounts.google.com/x');
  });

  it.each([
    ['rejected token', new BadRequestException('TURNSTILE_FAILED'), 'TURNSTILE_FAILED'],
    ['unreachable Cloudflare', new ServiceUnavailableException('TURNSTILE_UNAVAILABLE'), 'TURNSTILE_UNAVAILABLE'],
  ])('a %s stops the flow and sends the browser back to the FE callback with #error=<code> (not a raw JSON page)', async (_label, failure, code) => {
    const s = setup(true, jest.fn(async () => { throw failure; }));
    await s.controller.googleRedirect(undefined, undefined, 'c'.repeat(43), 'bad', s.req, s.res as never);
    expect(s.auth.issueOauthState).not.toHaveBeenCalled();
    expect(s.res.redirect).toHaveBeenCalledTimes(1);
    expect(s.res.redirect).toHaveBeenCalledWith(`http://localhost:3000/auth/callback#error=${code}`);
  });

  it('a failed start goes back to the allowlisted returnTo origin, and an unexpected (non-HTTP) failure still propagates', async () => {
    const config: Record<string, string> = { AUTH_SUCCESS_REDIRECT: 'https://app.example/', AUTH_ALLOWED_REDIRECT_ORIGINS: 'https://preview.example' };
    const verify = jest.fn(async () => { throw new BadRequestException('TURNSTILE_FAILED'); });
    const auth = { issueOauthState: jest.fn(), buildGoogleAuthUrl: jest.fn() };
    const controller = new AuthController(auth as never, { get: (key: string) => config[key] } as never, { enabled: true, verify } as never);
    const res = { redirect: jest.fn() };
    const req = { ip: '203.0.113.7', headers: {} } as never;
    await controller.googleRedirect(undefined, 'https://preview.example/x', 'c'.repeat(43), 'bad', req, res as never);
    expect(res.redirect).toHaveBeenCalledWith('https://preview.example/auth/callback#error=TURNSTILE_FAILED');
    verify.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.googleRedirect(undefined, undefined, 'c'.repeat(43), 'bad', req, res as never)).rejects.toThrow('boom');
  });

  it('an invalid PKCE challenge is #error=AUTH_FAILED on the FE callback too', async () => {
    const s = setup(false);
    s.auth.issueOauthState.mockRejectedValueOnce(new UnauthorizedException('INVALID_CODE_CHALLENGE'));
    await s.controller.googleRedirect(undefined, undefined, 'short', undefined, s.req, s.res as never);
    expect(s.res.redirect).toHaveBeenCalledWith('http://localhost:3000/auth/callback#error=AUTH_FAILED');
    expect(s.auth.buildGoogleAuthUrl).not.toHaveBeenCalled();
  });

  it('a repeated/array query value is treated as a missing token', async () => {
    const s = setup(true);
    await s.controller.googleRedirect(undefined, undefined, 'c'.repeat(43), ['a', 'b'], s.req, s.res as never);
    expect(s.verify).toHaveBeenCalledWith(undefined, '203.0.113.7');
  });

  it('when disabled the token is ignored and verify is never called', async () => {
    const s = setup(false);
    await s.controller.googleRedirect(undefined, undefined, 'c'.repeat(43), undefined, s.req, s.res as never);
    expect(s.verify).not.toHaveBeenCalled();
    expect(s.res.redirect).toHaveBeenCalled();
  });
});
