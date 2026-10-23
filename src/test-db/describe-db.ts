/**
 * TEST_DATABASE_URL이 없으면 전체 스위트를 skip (global-setup.ts가 이유를 출력한다).
 * harness.ts와 분리된 이유: harness는 global-setup/teardown(jest 전역 `describe`가 없는 컨텍스트)에서도 import된다.
 */
export const describeDb: jest.Describe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
