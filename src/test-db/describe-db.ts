import { testDatabaseUrl } from './harness';

/**
 * TEST_DATABASE_URL이 없으면 전체 스위트를 skip (global-setup.ts가 이유를 출력한다). CI=true 인데 없으면 testDatabaseUrl()이 throw 해
 * 스위트가 **실패**한다 - 시크릿이 빠진 CI 잡이 skip 으로 초록이 되지 않게.
 * harness.ts와 분리된 이유: harness는 global-setup/teardown(jest 전역 `describe`가 없는 컨텍스트)에서도 import된다.
 */
export const describeDb: jest.Describe = testDatabaseUrl() ? describe : describe.skip;
