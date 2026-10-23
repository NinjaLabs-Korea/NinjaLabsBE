import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../common/database/database.service';
import { AuthGuard } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';

/**
 * 실제 JwtService로 서명한 토큰을 AuthGuard에 넣어 본다 — OAuth state JWT는 같은 시크릿으로 서명되지만
 * typ: 'access'가 없으므로 Bearer로 제시되면 401이어야 한다.
 */
describe('AuthGuard token type binding', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const jwt = new JwtService({ secret: 'test-secret-test-secret-test-secret!', signOptions: { expiresIn: '5m' } });
  const service = new AuthService(
    { query: jest.fn(), tx: jest.fn() } as unknown as DatabaseService,
    jwt,
    { get: jest.fn() } as never,
    'test-secret-test-secret-test-secret!',
  );
  const guard = new AuthGuard(service);

  function context(authorization?: string) {
    const request: { headers: Record<string, string>; user?: SessionUser } = {
      headers: authorization ? { authorization } : {},
    };
    const executionContext = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { executionContext, request };
  }

  it('accepts an access token issued by AuthService (typ=access) and attaches the session user', async () => {
    const accessToken = await jwt.signAsync({ sub: userId, adm: false, typ: 'access' });
    const { executionContext, request } = context(`Bearer ${accessToken}`);
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.user).toEqual({ userId, isAdmin: false });
  });

  it('rejects an OAuth state JWT presented as a Bearer token with 401 INVALID_ACCESS_TOKEN', async () => {
    const state = await service.issueOauthState('trace', 'https://app.example/', 'c'.repeat(43));
    const { executionContext, request } = context(`Bearer ${state}`);
    const error = await guard.canActivate(executionContext).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).message).toBe('INVALID_ACCESS_TOKEN');
    expect(request.user).toBeUndefined();
  });

  // TODO(remove after 2026-11-30): flip back to a rejection together with the legacy branch in AuthService.verifyAccessToken
  it('still accepts a legacy access token issued before typ existed (no typ, no p, string sub) during the transition', async () => {
    const legacy = await jwt.signAsync({ sub: userId, adm: true });
    const { executionContext, request } = context(`Bearer ${legacy}`);
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.user).toEqual({ userId, isAdmin: true });
  });

  it('rejects a validly signed token with a typ other than access', async () => {
    const refreshLike = await jwt.signAsync({ sub: userId, adm: true, typ: 'refresh' });
    const { executionContext } = context(`Bearer ${refreshLike}`);
    await expect(guard.canActivate(executionContext)).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
  });

  it('rejects a missing or non-Bearer Authorization header before verifying anything', async () => {
    await expect(guard.canActivate(context().executionContext)).rejects.toMatchObject({ message: 'MISSING_BEARER_TOKEN' });
    await expect(guard.canActivate(context('Basic abc').executionContext)).rejects.toMatchObject({ message: 'MISSING_BEARER_TOKEN' });
  });
});
