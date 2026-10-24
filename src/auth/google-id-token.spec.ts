import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleIdTokenVerifier, GoogleVerifierUnavailableError } from './google-id-token.verifier';
import { createMockDb } from '../test-support/mock-db';

describe('AuthService Google id_token verification', () => {
  const clientId = 'client-id.apps.googleusercontent.com';
  const claims = {
    iss: 'https://accounts.google.com', aud: clientId, sub: 'google-sub', email: 'a@b.com', email_verified: true,
  };

  function setup(verify: jest.Mock, tokenResponse: { ok: boolean; body?: unknown } = { ok: true, body: { id_token: 'signed.id.token' } }) {
    global.fetch = jest.fn(async () => ({
      ok: tokenResponse.ok,
      json: async () => tokenResponse.body ?? {},
    })) as unknown as typeof fetch;
    const service = new AuthService(
      createMockDb().database,
      { signAsync: jest.fn() } as never,
      { get: jest.fn((key: string) => ({ GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: 's', GOOGLE_CALLBACK_URL: 'http://cb' })[key]) } as never,
      'dev-only-secret',
      { verify } as unknown as GoogleIdTokenVerifier,
    );
    return { service, verify };
  }

  it('verifies the id_token signature against the configured audience and returns the profile', async () => {
    const { service, verify } = setup(jest.fn(async () => claims));
    await expect(service.exchangeGoogleCode('code')).resolves.toEqual({ googleId: 'google-sub', email: 'a@b.com' });
    expect(verify).toHaveBeenCalledWith('signed.id.token', clientId);
  });

  it('rejects a token whose signature or audience fails verification', async () => {
    const { service } = setup(jest.fn(async () => { throw new Error('Wrong recipient'); }));
    await expect(service.exchangeGoogleCode('code')).rejects.toMatchObject({ message: 'INVALID_GOOGLE_ID_TOKEN' });
    const empty = setup(jest.fn(async () => undefined));
    await expect(empty.service.exchangeGoogleCode('code')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }, 'INVALID_GOOGLE_ID_TOKEN'],
    ['audience', { aud: 'other-client' }, 'INVALID_GOOGLE_ID_TOKEN'],
    ['missing subject', { sub: undefined }, 'INVALID_GOOGLE_ID_TOKEN'],
    ['unverified email', { email_verified: false }, 'GOOGLE_EMAIL_NOT_VERIFIED'],
  ])('keeps the claim checks after signature verification: %s', async (_label, override, code) => {
    const { service } = setup(jest.fn(async () => ({ ...claims, ...override })));
    await expect(service.exchangeGoogleCode('code')).rejects.toMatchObject({ message: code });
  });

  it('never calls the verifier when the code exchange itself fails', async () => {
    const { service, verify } = setup(jest.fn(), { ok: false });
    await expect(service.exchangeGoogleCode('code')).rejects.toMatchObject({ message: 'GOOGLE_CODE_EXCHANGE_FAILED' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('maps a JWKS fetch failure to 503 GOOGLE_UNAVAILABLE and warns, instead of blaming the token', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = setup(jest.fn(async () => {
      throw new GoogleVerifierUnavailableError('Failed to retrieve verification certificates: ECONNRESET');
    }));
    const error = await service.exchangeGoogleCode('code').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).message).toBe('GOOGLE_UNAVAILABLE');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
    warn.mockRestore();
  });
});

describe('GoogleIdTokenVerifier error classification', () => {
  const withProps = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

  it.each([
    ['certs endpoint wrapper message', new Error('Failed to retrieve verification certificates: request to https://www.googleapis.com/oauth2/v1/certs failed')],
    ['socket error code', withProps('socket hang up', { code: 'ECONNRESET' })],
    ['dns error code', withProps('getaddrinfo ENOTFOUND www.googleapis.com', { code: 'ENOTFOUND' })],
    ['timeout code', withProps('timeout', { code: 'ETIMEDOUT' })],
    ['FetchError', Object.assign(new Error('network'), { name: 'FetchError' })],
    ['non-2xx from the certs endpoint (gaxios status)', withProps('Service Unavailable', { status: 503 })],
    ['non-2xx via response.status', withProps('Bad Gateway', { response: { status: 502 } })],
  ])('treats %s as unavailable', (_label, err) => {
    expect(GoogleIdTokenVerifier.isUnavailable(err)).toBe(true);
  });

  it.each([
    ['bad audience', new Error('Wrong recipient, payload audience != requiredAudience')],
    ['expired', new Error('Token used too late, 1 > 0: {"exp":0}')],
    ['bad signature', new Error('Invalid token signature: a.b.c')],
    ['bad issuer', new Error('Invalid issuer, expected one of [accounts.google.com], but got evil')],
    ['no pem for kid', new Error('No pem found for envelope: {"kid":"x"}')],
    ['non-error throwable', 'string failure'],
  ])('keeps %s as a verification failure (401)', (_label, err) => {
    expect(GoogleIdTokenVerifier.isUnavailable(err)).toBe(false);
  });

  it('wraps only unavailable failures from the underlying client', async () => {
    const verifier = new GoogleIdTokenVerifier();
    const client = verifier['client'] as { verifyIdToken: unknown };
    client.verifyIdToken = jest.fn(async () => { throw withProps('socket hang up', { code: 'ECONNRESET' }); });
    await expect(verifier.verify('t', 'aud')).rejects.toBeInstanceOf(GoogleVerifierUnavailableError);
    client.verifyIdToken = jest.fn(async () => { throw new Error('Wrong recipient, payload audience != requiredAudience'); });
    await expect(verifier.verify('t', 'aud')).rejects.toMatchObject({ name: 'Error', message: /Wrong recipient/ });
  });
});

describe('AuthController OAuth callback failure redirect', () => {
  it.each([
    ['503 GOOGLE_UNAVAILABLE', new ServiceUnavailableException('GOOGLE_UNAVAILABLE')],
    ['401 INVALID_GOOGLE_ID_TOKEN', new UnauthorizedException('INVALID_GOOGLE_ID_TOKEN')],
  ])('redirects %s from the code exchange to the same #error=AUTH_FAILED fragment', async (_label, failure) => {
    const config = { get: (key: string) => ({ AUTH_SUCCESS_REDIRECT: 'https://app.example/' })[key] };
    const auth = {
      verifyOauthState: jest.fn(async () => ({ redirectUrl: 'https://app.example/', codeChallenge: 'c'.repeat(43) })),
      exchangeGoogleCode: jest.fn(async () => { throw failure; }),
      upsertGoogleUser: jest.fn(),
      issueLoginCode: jest.fn(),
    };
    const controller = new AuthController(auth as never, config as never, { enabled: false } as never);
    const res = { redirect: jest.fn() };
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await controller.googleCallback('code', 'state', undefined, {} as never, res as never);
    expect(res.redirect).toHaveBeenCalledWith('https://app.example/auth/callback#error=AUTH_FAILED');
    expect(auth.upsertGoogleUser).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
});

describe('AuthController returnTo allowlist', () => {
  function redirectFor(returnTo: string, allowed: string) {
    const config = { get: (key: string) => ({ AUTH_SUCCESS_REDIRECT: 'https://app.example/', AUTH_ALLOWED_REDIRECT_ORIGINS: allowed })[key] };
    const auth = {
      issueOauthState: jest.fn(async (_trace: string | undefined, _redirect: string, _challenge: string) => 'state'),
      buildGoogleAuthUrl: jest.fn(() => 'https://accounts.google.com/x'),
    };
    const controller = new AuthController(auth as never, config as never, { enabled: false } as never);
    const res = { redirect: jest.fn() };
    return controller.googleRedirect(undefined, returnTo, 'c'.repeat(43), undefined, {} as never, res as never).then(() => auth.issueOauthState.mock.calls[0][1]);
  }

  it('accepts wildcard preview origins on team-owned domains and exact Vercel branch aliases, falling back for anything else', async () => {
    const allowed = ' https://ninjalabsfe-*-team.preview.example , https://staging.example, https://ninjalabsfe-git-develop-team.vercel.app';
    await expect(redirectFor('https://ninjalabsfe-abc-team.preview.example/bounties', allowed)).resolves.toBe('https://ninjalabsfe-abc-team.preview.example/');
    await expect(redirectFor('https://ninjalabsfe-git-develop-team.vercel.app/bounties', allowed)).resolves.toBe('https://ninjalabsfe-git-develop-team.vercel.app/');
    await expect(redirectFor('https://staging.example/x', allowed)).resolves.toBe('https://staging.example/');
    await expect(redirectFor('https://app.example/x', allowed)).resolves.toBe('https://app.example/');
    await expect(redirectFor('https://ninjalabsfe-abc-team.vercel.app/x', allowed)).resolves.toBe('https://app.example/');
    await expect(redirectFor('https://evil.com/?x=https://ninjalabsfe-a-team.preview.example', allowed)).resolves.toBe('https://app.example/');
    await expect(redirectFor('http://ninjalabsfe-a-team.preview.example/', allowed)).resolves.toBe('https://app.example/');
  });

  it('drops a "team-scoped" wildcard on a shared hosting domain, so an attacker project matching it never receives the login code', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(redirectFor('https://ninjalabsfe-evil-team.vercel.app/x', 'https://ninjalabsfe-*-team.vercel.app')).resolves.toBe('https://app.example/');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REJECTED'));
    error.mockRestore();
  });
});
