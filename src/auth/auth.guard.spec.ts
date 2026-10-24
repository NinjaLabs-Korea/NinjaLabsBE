import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DatabaseService } from '../common/database/database.service';
import { AuthGuard } from './auth.guard';
import { AuthService, SessionUser } from './auth.service';
import { USER_STATUS_CACHE_MAX } from './user-status-cache';

/**
 * 실제 JwtService로 서명한 토큰을 AuthGuard에 넣어 본다 — OAuth state JWT는 같은 시크릿으로 서명되지만
 * typ: 'access'가 없으므로 Bearer로 제시되면 401이어야 한다.
 */
describe('AuthGuard token type binding', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const jwt = new JwtService({ secret: 'test-secret-test-secret-test-secret!', signOptions: { expiresIn: '5m' } });
  // 유저 상태 확인(assertActiveUser)은 활성 유저로 답한다 — 비활성/캐시는 아래 별도 describe
  const service = new AuthService(
    { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{}] }), tx: jest.fn() } as unknown as DatabaseService,
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
  it('still accepts a legacy access token issued before typ existed (no typ, no p, string sub) if it predates this process', async () => {
    const legacy = await jwt.signAsync({ sub: userId, adm: true, iat: Math.floor(performance.timeOrigin / 1000) - 60 });
    const { executionContext, request } = context(`Bearer ${legacy}`);
    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(request.user).toEqual({ userId, isAdmin: true });
  });

  it('rejects a typ-less token signed after this process started (the transition only covers tokens of the previous deploy)', async () => {
    const fresh = await jwt.signAsync({ sub: userId, adm: true });
    await expect(guard.canActivate(context(`Bearer ${fresh}`).executionContext)).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
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

describe('AuthGuard user status (suspended / deleted users)', () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const secret = 'test-secret-test-secret-test-secret!';
  const jwt = new JwtService({ secret, signOptions: { expiresIn: '5m' } });

  function setup(activeRows: number[]) {
    const query = jest.fn();
    for (const rowCount of activeRows) query.mockResolvedValueOnce({ rowCount, rows: rowCount ? [{}] : [] });
    const service = new AuthService({ query, tx: jest.fn() } as unknown as DatabaseService, jwt, { get: jest.fn() } as never, secret);
    const request: { headers: Record<string, string>; user?: SessionUser } = { headers: {} };
    const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
    return { service, guard: new AuthGuard(service), query, request, context };
  }

  it('rejects a valid access token whose user is no longer ACTIVE or is deleted with 401 INVALID_ACCESS_TOKEN', async () => {
    const { guard, query, request, context } = setup([0]);
    request.headers.authorization = `Bearer ${await jwt.signAsync({ sub: userId, adm: false, typ: 'access' })}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 401, message: 'INVALID_ACCESS_TOKEN' });
    expect(request.user).toBeUndefined();
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain('deleted_at IS NULL');
    expect(params).toEqual([userId]);
  });

  it('caches the status per user for 30 s (one query per window), then re-checks', async () => {
    const { service, query } = setup([1, 0]);
    const t0 = 1_000_000;
    await service.assertActiveUser(userId, t0);
    await service.assertActiveUser(userId, t0 + 29_999);
    expect(query).toHaveBeenCalledTimes(1);
    await expect(service.assertActiveUser(userId, t0 + 30_000)).rejects.toMatchObject({ message: 'INVALID_ACCESS_TOKEN' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache by evicting the oldest entry', async () => {
    const { service, query } = setup([]);
    query.mockResolvedValue({ rowCount: 1, rows: [{}] });
    const cache = (service as unknown as { userStatusCache: Map<string, unknown> }).userStatusCache;
    for (let i = 0; i <= USER_STATUS_CACHE_MAX; i++) await service.assertActiveUser(`u${i}`, 0);
    expect(cache.size).toBe(USER_STATUS_CACHE_MAX);
    expect(cache.has('u0')).toBe(false);
    expect(cache.has(`u${USER_STATUS_CACHE_MAX}`)).toBe(true);
  });
});
