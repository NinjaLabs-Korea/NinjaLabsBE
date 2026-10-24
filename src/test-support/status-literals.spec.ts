import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * 정적 가드 — 제출/지원서 상태 **집합**을 문자열 리터럴로 새로 만들지 못하게 한다 (README "코드 배치 규칙").
 *
 * 규칙 집합(심사 가능·미결·확정 등)은 bounties/submission-status.ts, bounties/application-status.ts가 단일 출처다.
 * 상태 리터럴 두 개 이상이 나란히 놓인 TS 배열(`['SUBMITTED', 'RESUBMITTED', …]`)이나 SQL IN 목록(`IN ('SUBMITTED','IN_REVIEW')`)은
 * 그 규칙의 사본이므로 실패시킨다 — 정책 helper(+ SQL은 `= ANY($n::text[])` 바인딩)를 쓰도록 고친다.
 * 단일 값 비교(`status = 'APPROVED'`)는 허용한다 (정책 파일 머리 주석 참고).
 * payout/보상/NFT 상태처럼 값이 겹쳐도 다른 도메인 집합(예 `IN ('APPROVED', 'BROADCASTING')`)은 둘째 값이 이 목록에 없어 걸리지 않는다.
 */
const STATUS = '(?:SUBMITTED|RESUBMITTED|IN_REVIEW|REVISION_REQUESTED|APPROVED|REJECTED|WITHDRAWN|PENDING)';
const SET_LITERAL = new RegExp(`(?:\\[|\\bIN\\s*\\()\\s*'${STATUS}'\\s*,\\s*'${STATUS}'`, 'i');

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
    if (SET_LITERAL.test(line)) lines.push(i + 1);
  });
  return lines;
}

describe('submission/application status sets come from the policy files (static guard)', () => {
  it('flags a TS array or SQL IN list of two or more status literals', () => {
    expect(findStatusSetLiterals(`if (['APPROVED', 'REJECTED'].includes(s)) {}`)).toEqual([1]);
    expect(findStatusSetLiterals(`const x = 1;\n  AND status IN ('SUBMITTED','RESUBMITTED','IN_REVIEW','REVISION_REQUESTED')`)).toEqual([2]);
    expect(findStatusSetLiterals(`@IsIn(['APPROVED', 'REJECTED']) decision!: string;`)).toEqual([1]);
  });

  it('allows single-value comparisons, other domains\' sets and comments', () => {
    expect(findStatusSetLiterals(`WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL`)).toEqual([]);
    expect(findStatusSetLiterals(`WHERE id = $1 AND status IN ('APPROVED', 'BROADCASTING')`)).toEqual([]);
    expect(findStatusSetLiterals(`export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED'] as const;`)).toEqual([]);
    expect(findStatusSetLiterals(`// e.g. ['APPROVED', 'REJECTED']\n * IN ('PENDING', 'APPROVED')`)).toEqual([]);
  });

  it('no source file outside the policy files builds such a set', () => {
    const root = join(__dirname, '..');
    const offenders = listSourceFiles(root).flatMap((file) =>
      findStatusSetLiterals(readFileSync(file, 'utf8')).map((line) => `${relative(root, file)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
