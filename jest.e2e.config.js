// HTTP e2e - `npm run test:e2e`. 진짜 AppModule을 main.ts와 같은 configureApp()으로 띄워 실 Postgres(모든 마이그레이션 적용)에 대해
// HTTP로 구동한다. DB 준비/정리는 test-db와 같은 global-setup/teardown(실행마다 새 DB). TEST_DATABASE_URL이 없으면 로컬은 skip, CI=true면 실패.
// 하네스와 대역(외부 I/O만): src/test-e2e/support/.
/** @type {import('jest').Config} */
// eslint-disable-next-line no-undef
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/test-e2e'],
  testRegex: '\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/src/test-db/global-setup.ts',
  globalTeardown: '<rootDir>/src/test-db/global-teardown.ts',
  // ESM 전용 패키지(jest가 못 불러온다) - 주소 변환은 실제 bech32로 대체, 체인/ADR-36 클래스는 호출 시 실패 (support/*.stub.ts 머리 주석)
  moduleNameMapper: {
    '^@injectivelabs/sdk-ts$': '<rootDir>/src/test-e2e/support/injective-sdk.stub.ts',
    '^@cosmjs/amino$': '<rootDir>/src/test-e2e/support/cosmjs-amino.stub.ts',
  },
  // 파일마다 앱 하나 + 데이터베이스 하나를 공유하므로 직렬 실행
  maxWorkers: 1,
  testTimeout: 60_000,
};
