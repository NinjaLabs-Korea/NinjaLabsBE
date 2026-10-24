import { USER_STATUS_CACHE_MAX, USER_STATUS_CACHE_TTL_MS, UserStatusCache } from './user-status-cache';

/**
 * 유저 상태 캐시 규칙 문서 — 결과는 30초 동안만 믿고(그 뒤엔 DB 재확인), 상한을 넘으면 가장 오래 넣은 항목부터 버린다.
 * DB 조회와 401 변환은 AuthService.assertActiveUser 몫 (auth.guard.spec.ts).
 */
describe('UserStatusCache', () => {
  it(`serves a result for ${USER_STATUS_CACHE_TTL_MS} ms, then reports a miss`, () => {
    const cache = new UserStatusCache();
    expect(cache.get('u', 0)).toBeUndefined();
    cache.set('u', false, 1_000);
    expect(cache.get('u', 1_000 + USER_STATUS_CACHE_TTL_MS - 1)).toBe(false);
    expect(cache.get('u', 1_000 + USER_STATUS_CACHE_TTL_MS)).toBeUndefined();
  });

  it('forget drops one user so the next check goes to the database', () => {
    const cache = new UserStatusCache();
    cache.set('u', true, 0);
    cache.set('v', true, 0);
    cache.forget('u');
    expect(cache.get('u', 0)).toBeUndefined();
    expect(cache.get('v', 0)).toBe(true);
  });

  it('re-setting a user moves it to the back of the eviction order', () => {
    const cache = new UserStatusCache();
    for (let i = 0; i < USER_STATUS_CACHE_MAX; i++) cache.set(`u${i}`, true, 0);
    cache.set('u0', true, 1); // refreshed → no longer the oldest
    cache.set('new', true, 1);
    expect(cache.size).toBe(USER_STATUS_CACHE_MAX);
    expect(cache.has('u0')).toBe(true);
    expect(cache.has('u1')).toBe(false);
  });
});
