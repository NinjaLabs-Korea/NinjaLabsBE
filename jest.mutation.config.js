// 뮤테이션 테스트 전용 jest 설정 - `npm run test:mutation` (stryker.config.mjs). CI에는 붙이지 않는다.
// 단위 스펙(src/**/*.spec.ts)과 실DB 스펙(src/test-db/*.db-spec.ts)을 한 번에 돌려, 돈 경로 SQL 조각처럼 단위 스펙이 못 보는 변형도
// test:db가 죽이게 한다. DB 준비/정리는 test:db와 같은 global-setup/teardown(실행마다 새 DB, TEST_DATABASE_URL 필요).
// e2e는 넣지 않는다: ESM 스텁 moduleNameMapper가 단위 스펙의 jest.mock과 섞이고, 돈 경로 규칙은 test:db가 이미 덮는다.
/** @type {import('jest').Config} */
// eslint-disable-next-line no-undef
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src'],
  // MUTATION_TEST_REGEX: stryker.config.mjs의 scripts 범위가 스크립트를 부르는 스펙만 돌리도록 좁힌다
  // eslint-disable-next-line no-undef
  testRegex: process.env.MUTATION_TEST_REGEX || '(\\.spec|\\.db-spec)\\.ts$',
  // error-codes.spec.ts는 소스 텍스트에서 `throw new XxxException('CODE')`를 정규식으로 찾는다. Stryker가 계측한 소스에서는 그 모양이 깨져
  // 초기 실행이 실패하므로 뺀다(카탈로그 대조는 평소 `npm test`가 지킨다).
  testPathIgnorePatterns: ['/node_modules/', '/src/test-support/error-codes\\.spec\\.ts$'],
  globalSetup: '<rootDir>/src/test-db/global-setup.ts',
  globalTeardown: '<rootDir>/src/test-db/global-teardown.ts',
  maxWorkers: 1,
  testTimeout: 60_000,
};
