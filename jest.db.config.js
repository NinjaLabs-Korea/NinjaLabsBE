// 실 Postgres 통합 테스트 — `npm run test:db` (TEST_DATABASE_URL 없으면 전부 skip). src/test-db/README 격인 harness.ts 참고.
/** @type {import('jest').Config} */
// eslint-disable-next-line no-undef
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/test-db'],
  testRegex: '\\.db-spec\\.ts$',
  globalSetup: '<rootDir>/src/test-db/global-setup.ts',
  globalTeardown: '<rootDir>/src/test-db/global-teardown.ts',
  // 스위트들이 데이터베이스 하나를 공유하므로 직렬 실행 (package.json 스크립트의 --runInBand와 동일한 의도)
  maxWorkers: 1,
  testTimeout: 60_000,
};
