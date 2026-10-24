import { MAX_REFRESH_TTL_SECONDS, MIN_REFRESH_TTL_SECONDS, normalizeRefreshTtl, refreshTtlSeconds } from './refresh-ttl';

/**
 * JWT_REFRESH_TTL 규칙 문서 — 문법(`<정수>[공백]<단위>`), 단위 정규화, 허용 범위(60초~90일), 미설정 기본값(14d).
 * 규칙을 바꾸면 refresh-ttl.ts와 이 표를 함께 고친다.
 */
describe('normalizeRefreshTtl (JWT_REFRESH_TTL grammar)', () => {
  it.each([
    ['14d', '14 days'],
    ['15m', '15 minutes'], // m is always minutes, never months
    ['2 weeks', '2 weeks'],
    ['12h', '12 hours'],
    ['60s', '60 seconds'],
    ['3 day', '3 days'],
    ['  7d  ', '7 days'],
  ])('%j → %j', (raw, normalized) => {
    expect(normalizeRefreshTtl(raw)).toBe(normalized);
  });

  it('defaults to 14 days when unset', () => {
    expect(normalizeRefreshTtl(undefined)).toBe('14 days');
  });

  it.each(['14', 'd', '1.5d', '-1d', '1mo', '1y', '14 days ago', ''])('rejects %j as not "<integer> <unit>"', (raw) => {
    expect(() => normalizeRefreshTtl(raw)).toThrow('JWT_REFRESH_TTL must be "<integer> <unit>"');
  });

  it(`rejects lifetimes outside ${MIN_REFRESH_TTL_SECONDS} s .. 90 days, accepts both bounds`, () => {
    expect(() => normalizeRefreshTtl('0s')).toThrow('must be between');
    expect(() => normalizeRefreshTtl('59s')).toThrow('must be between');
    expect(() => normalizeRefreshTtl('91d')).toThrow('must be between');
    expect(normalizeRefreshTtl('1m')).toBe('1 minutes');
    expect(refreshTtlSeconds(normalizeRefreshTtl('90d'))).toBe(MAX_REFRESH_TTL_SECONDS);
  });
});
