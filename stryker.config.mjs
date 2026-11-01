// @ts-check
/* global process */
/**
 * 돈 경로 뮤테이션 테스트 - `TEST_DATABASE_URL=... npm run test:mutation` (로컬 수동 실행, CI에는 붙이지 않는다).
 * 대상: 돈이 움직이거나 판정되는 코드(입금 확인, 지급 요청·2인 승인·mark-paid, 보상 상태 재계산, 지급 상태 SQL, 완료·취소 차단,
 * 환불·보상 미지급 스크립트, 금액·해시 검증). 테스트는 jest.mutation.config.js(단위 + 실DB)로 돌린다.
 * 결과: reports/mutation/mutation.html. 동시성은 코어 수의 절반 이하로 둔다(각 러너가 DB를 하나씩 만든다).
 */
/**
 * 범위 두 개:
 *   기본(`npm run test:mutation`)   src의 돈 경로 TS. perTest 커버리지로 변형마다 그 줄을 지나는 테스트만 돌린다.
 *   scripts(`npm run test:mutation:scripts`)   scripts/record-refund.js, scripts/forfeit-award.js. perTest 커버리지가 ops-scripts.db-spec의
 *     테스트를 이 파일들에 연결하지 못해(직접 확인: 살아남았다고 나온 변형을 손으로 넣으면 그 스펙이 실패) 커버리지 분석을 끄고,
 *     스크립트를 부르는 스펙만(약 5초) 변형마다 전부 돌린다.
 */
const scriptsScope = process.env.MUTATION_SCOPE === 'scripts';
if (scriptsScope) {
  process.env.MUTATION_TEST_REGEX = '(ops-scripts|refund-forfeit-races|bounty-flow|bounty-rules)\\.db-spec\\.ts$|(forfeit-award|ops-cli|payout-status|tx-hash)\\.spec\\.ts$';
}

const SRC_TARGETS = [
  'src/rewards/payout-status.ts',
  'src/rewards/rewards.service.ts',
  'src/rewards/payout-approval.ts',
  'src/rewards/reward-token-decimals.ts',
  'src/rewards/payout.worker.ts',
  'src/bounties/admin/bounty-lifecycle.service.ts',
  'src/bounties/completed-wins.ts',
  'src/common/validation/tx-hash.ts',
  'src/common/validation/token-amount.ts',
];
const SCRIPT_TARGETS = [
  'scripts/record-refund.js',
  // 사유 글자 검사(reasonProblem/normalizeReason, 문자열 규칙)는 뺀다: forfeit-award.spec.ts가 전 코드 포인트(110만 개)를 돌려 계측 상태에서는
  // 러너가 SIGSEGV로 죽는다. 그 규칙은 TS 원본과의 전수 대조가 지킨다. 돈 판정(상수, 조회, 거부 사유, 쓰기)만 변형한다.
  'scripts/forfeit-award.js:29-31',
  'scripts/forfeit-award.js:58-213',
];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  testRunner: 'jest',
  jest: { configFile: 'jest.mutation.config.js', enableFindRelatedTests: false },
  coverageAnalysis: scriptsScope ? 'off' : 'perTest',
  mutate: scriptsScope ? SCRIPT_TARGETS : SRC_TARGETS,
  // 모듈 최상위 상수(상태 집합 등)의 변형은 매번 전체 스위트(약 50초)를 돌려야 해 실행이 몇 시간으로 늘어난다. 그런 정적 변형은 건너뛰고
  // (리포트에 Ignored로 남는다) 상태 집합의 원소 누락은 mutation/sql-mutants.mjs가 원소 단위로 표적 변형한다.
  ignoreStatic: !scriptsScope,
  concurrency: 4,
  // 잠금을 지우는 변형은 경합 스펙의 waitForLockWaiter가 테스트 타임아웃까지 기다리게 만든다 - 15초 여유면 충분히 시간 초과(killed)로 잡힌다.
  timeoutMS: 15_000,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: `reports/mutation/${scriptsScope ? 'scripts' : 'src'}.html` },
  jsonReporter: { fileName: `reports/mutation/${scriptsScope ? 'scripts' : 'src'}.json` },
  thresholds: { high: 90, low: 80, break: null },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
export default config;
