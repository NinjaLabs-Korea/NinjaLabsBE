import { testDatabaseUrl } from './harness';

/** 유닛 스위트(`npm test`)에서 도는 하네스 가드 - CI 에서 TEST_DATABASE_URL 이 빠지면 skip 이 아니라 실패해야 한다 */
describe('test-db harness: TEST_DATABASE_URL gate', () => {
  it('returns the URL when set, regardless of CI', () => {
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://x' })).toBe('postgresql://x');
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgresql://x', CI: 'true' })).toBe('postgresql://x');
  });

  it('returns undefined (→ describe.skip) when unset locally, treating an empty string as unset', () => {
    expect(testDatabaseUrl({})).toBeUndefined();
    expect(testDatabaseUrl({ TEST_DATABASE_URL: '' })).toBeUndefined();
    expect(testDatabaseUrl({ CI: 'false' })).toBeUndefined();
  });

  it('throws when CI=true and TEST_DATABASE_URL is unset or empty, so the db-tests job cannot pass by skipping', () => {
    expect(() => testDatabaseUrl({ CI: 'true' })).toThrow(/TEST_DATABASE_URL is not set while CI=true/);
    expect(() => testDatabaseUrl({ CI: 'true', TEST_DATABASE_URL: '' })).toThrow(/must RUN in CI, not skip/);
  });
});
