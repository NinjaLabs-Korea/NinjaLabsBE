import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * 정적 가드 — 제출/지원서/payout 상태 **집합**을 문자열 리터럴로 새로 만들지 못하게 한다 (README "코드 배치 규칙").
 *
 * 규칙 집합(심사 가능·미결·확정 등)은 bounties/submission-status.ts, bounties/application-status.ts가 단일 출처다.
 * payout 상태 집합(진행 중·종료·배정·미정산 등)과 배정 상한식 LEAST(…amount, …deposited_amount)는 rewards/payout-status.ts가 단일 출처다 —
 * 새 규칙이 필요하면 그 파일에 상수/헬퍼를 추가하고 SQL에는 sqlStatusList()/헬퍼로 렌더링한다.
 * 상태 리터럴 두 개 이상이 나란히 놓인 TS 배열(`['SUBMITTED', 'RESUBMITTED', …]`)이나 SQL IN 목록(`IN ('SUBMITTED','IN_REVIEW')`)은
 * 그 규칙의 사본이므로 실패시킨다 — 정책 helper(+ SQL은 `= ANY($n::text[])` 바인딩)를 쓰도록 고친다.
 * 바운티 상태 집합과 공개 노출 조건은 bounties/bounty-status.ts(BountyStatusPolicy, publicBountySql)가 단일 출처다 —
 * `status NOT IN ('DRAFT', 'FUNDING_PENDING')` 같은 공개 필터 사본은 열리기 전에 취소된 바운티를 공개했다.
 * 단일 값 비교(`status = 'APPROVED'`)는 허용한다 (정책 파일 머리 주석 참고).
 * 보상/NFT 상태처럼 값이 겹쳐도 다른 도메인 집합(예 `IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')`)은 앞 두 값이 같은 목록에 없어 걸리지 않는다.
 * 앞 두 값만 본다 — 두 값이 같은 도메인 목록에 있으면 그 도메인의 집합 사본으로 본다.
 */
const SUBMISSION_STATUS = '(?:SUBMITTED|RESUBMITTED|IN_REVIEW|REVISION_REQUESTED|APPROVED|REJECTED|WITHDRAWN|PENDING)';
/** payout.status 전체 (rewards/payout-status.ts PAYOUT_ROW_STATUSES — 그 파일의 스펙이 마이그레이션 CHECK와 대조한다) */
const PAYOUT_STATUS = '(?:REQUESTED|AWAITING_MULTISIG_APPROVAL|APPROVED|BROADCASTING|PAID|FAILED|CANCELLED)';
/** bounty.status 전체 (bounties/bounty-status.ts BountyStatus) */
const BOUNTY_STATUS = '(?:DRAFT|FUNDING_PENDING|OPEN|SUBMISSION_CLOSED|IN_REVIEW|COMPLETED|CANCELLED)';
const setLiteral = (status: string) => new RegExp(`(?:\\[|\\bIN\\s*\\()\\s*'${status}'\\s*,\\s*'${status}'`, 'i');
const SET_LITERALS = [setLiteral(SUBMISSION_STATUS), setLiteral(PAYOUT_STATUS), setLiteral(BOUNTY_STATUS)];
/** 배정 상한식 사본 — rewardCapSql()을 쓴다 */
const CAP_LITERAL = /LEAST\(\s*(?:\w+\.)?amount\s*,\s*(?:\w+\.)?deposited_amount\s*\)/i;
/** 규칙의 출처 파일 — 여기서만 리터럴 집합을 쓴다 */
const POLICY_FILES = ['bounties/bounty-status.ts', 'bounties/submission-status.ts', 'bounties/application-status.ts', 'rewards/payout-status.ts'];

/** src 아래 비-스펙 .ts 파일 (sql-param-casts.spec.ts와 같은 기준 — 스펙 파일을 import하면 그 테스트가 여기서도 돌아 따로 둔다) */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') listSourceFiles(full, out);
    } else if (/\.ts$/.test(entry) && !/\.(spec|db-spec|e2e-spec|d)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

export function findStatusSetLiterals(source: string): number[] {
  const lines: number[] = [];
  source.split('\n').forEach((line, i) => {
    const code = line.trimStart();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    if (SET_LITERALS.some((re) => re.test(line)) || CAP_LITERAL.test(line)) lines.push(i + 1);
  });
  return lines;
}

describe('submission/application/payout/bounty status sets come from the policy files (static guard)', () => {
  it('flags a TS array or SQL IN list of two or more status literals', () => {
    expect(findStatusSetLiterals(`if (['APPROVED', 'REJECTED'].includes(s)) {}`)).toEqual([1]);
    expect(findStatusSetLiterals(`const x = 1;\n  AND status IN ('SUBMITTED','RESUBMITTED','IN_REVIEW','REVISION_REQUESTED')`)).toEqual([2]);
    expect(findStatusSetLiterals(`@IsIn(['APPROVED', 'REJECTED']) decision!: string;`)).toEqual([1]);
  });

  it('flags payout status sets (open / terminal / allocated …) and the allocation cap written outside rewards/payout-status.ts', () => {
    expect(findStatusSetLiterals(`WHERE id = $1 AND status IN ('APPROVED', 'BROADCASTING')`)).toEqual([1]);
    expect(findStatusSetLiterals(`AND p.status NOT IN ('PAID', 'CANCELLED', 'FAILED')`)).toEqual([1]);
    expect(findStatusSetLiterals(`export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED'] as const;`)).toEqual([1]);
    expect(findStatusSetLiterals(`count(*) FILTER (WHERE status NOT IN ('PAID','CANCELLED'))`)).toEqual([1]);
    expect(findStatusSetLiterals(`SELECT LEAST(rw.amount, rw.deposited_amount)::text AS cap`)).toEqual([1]);
    expect(findStatusSetLiterals(`SELECT LEAST(amount, deposited_amount) FROM bounty_reward`)).toEqual([1]);
  });

  it('flags bounty status sets — e.g. the old public filter that leaked bounties cancelled before they opened (use publicBountySql)', () => {
    expect(findStatusSetLiterals(`AND b.status NOT IN ('DRAFT', 'FUNDING_PENDING')`)).toEqual([1]);
    expect(findStatusSetLiterals(`const conds = [\`b.deleted_at IS NULL\`, \`b.status NOT IN ('DRAFT','FUNDING_PENDING')\`];`)).toEqual([1]);
    expect(findStatusSetLiterals(`WHERE status IN ('OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW')`)).toEqual([1]);
  });

  it('allows single-value comparisons, other domains\' sets and comments', () => {
    expect(findStatusSetLiterals(`WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL`)).toEqual([]);
    expect(findStatusSetLiterals(`AND p.status = 'PAID' AND px.status <> 'CANCELLED'`)).toEqual([]);
    expect(findStatusSetLiterals(`AND rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')`)).toEqual([]);
    expect(findStatusSetLiterals(`export const NFT_JOB_ADMIN_STATUSES = ['FAILED', 'PENDING', 'PROCESSING'] as const;`)).toEqual([]);
    expect(findStatusSetLiterals(`AND status IN (\${sqlStatusList(OPEN_PAYOUT_STATUSES)})`)).toEqual([]);
    expect(findStatusSetLiterals(`// e.g. ['APPROVED', 'REJECTED']\n * IN ('PENDING', 'APPROVED')`)).toEqual([]);
  });

  it('no source file outside the policy files builds such a set', () => {
    const root = join(__dirname, '..');
    const offenders = listSourceFiles(root).filter((file) => !POLICY_FILES.includes(relative(root, file))).flatMap((file) =>
      findStatusSetLiterals(readFileSync(file, 'utf8')).map((line) => `${relative(root, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
