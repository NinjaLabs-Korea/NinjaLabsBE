import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../common/http/error-codes';

/**
 * 정적 가드 — 서비스가 던지는 에러 코드 ↔ `common/http/error-codes.ts` 카탈로그 ↔ `docs/api-contract.md` 코드 표가
 * 서로 정확히 같은지(양방향, HTTP 상태 포함) 검사한다.
 *
 * 새 코드를 던졌는데 이 스펙이 실패하면: error-codes.ts에 항목을 추가하고, api-contract.md의 표(BEGIN/END 사이)에 같은 행을 넣는다.
 * 카탈로그/문서에만 남은 코드가 실패하면: 던지는 곳이 사라진 것이니 그 항목을 지운다.
 *
 * 스캔 대상은 `new XxxException('UPPER_SNAKE'…` 리터럴(또는 `INVALID_TRANSITION:${…}` 같은 템플릿의 접두사)이다.
 * 코드를 상수/변수로 넘기면 스캔에 안 잡힌다 — 에러 코드는 리터럴로 던진다 (그래서 grep으로도 찾힌다).
 */

const STATUS_BY_CLASS: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  ConflictException: 409,
  ServiceUnavailableException: 503,
};
const THROW = /new (\w+Exception)\(\s*[`']([A-Z][A-Z0-9_]+)/g;
const DOC_BEGIN = '<!-- error-codes:begin -->';
const DOC_END = '<!-- error-codes:end -->';
const SRC_ROOT = join(__dirname, '..');

/** 운영 소스(.ts)만 — 스펙/db-spec/e2e/d.ts 제외 (sql-param-casts.spec.ts의 listSourceFiles와 같은 기준; 다른 스펙을 import하면 그 테스트가 중복 등록돼 따로 둔다) */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.ts$/.test(entry) && !/\.(spec|db-spec|e2e-spec|d)\.ts$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/** 소스에서 던져지는 `code -> 상태 집합` (오름차순) */
function scanThrownCodes(): Map<string, number[]> {
  const found = new Map<string, Set<number>>();
  for (const file of listSourceFiles(SRC_ROOT)) {
    if (file.endsWith(join('common', 'http', 'error-codes.ts'))) continue; // 카탈로그 머리 주석의 예시(`XxxException('NEW_CODE')`)는 던지는 곳이 아니다
    for (const [, cls, code] of readFileSync(file, 'utf8').matchAll(THROW)) {
      const status = STATUS_BY_CLASS[cls];
      if (status === undefined) throw new Error(`${file}: ${cls}('${code}') — STATUS_BY_CLASS에 이 예외 클래스를 추가하세요`);
      (found.get(code) ?? found.set(code, new Set()).get(code)!).add(status);
    }
  }
  return new Map([...found].map(([code, set]) => [code, [...set].sort((a, b) => a - b)]));
}

/** 문서 표의 `| \`CODE\` | 400, 404 | 의미 |` 행들 */
function docRows(): Map<string, { statuses: number[]; ko: string }> {
  const doc = readFileSync(join(SRC_ROOT, '..', 'docs', 'api-contract.md'), 'utf8');
  const begin = doc.indexOf(DOC_BEGIN);
  const end = doc.indexOf(DOC_END);
  if (begin < 0 || end < begin) throw new Error(`docs/api-contract.md에 ${DOC_BEGIN} … ${DOC_END} 표식이 필요합니다`);
  const rows = new Map<string, { statuses: number[]; ko: string }>();
  for (const line of doc.slice(begin, end).split('\n')) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*([\d,\s]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (m) rows.set(m[1], { statuses: m[2].split(',').map((s) => Number(s.trim())), ko: m[3] });
  }
  return rows;
}

describe('에러 코드 카탈로그 (error-codes.ts)', () => {
  const thrown = scanThrownCodes();
  const catalog = Object.keys(ERROR_CODES).sort();

  it('소스가 던지는 코드는 전부 카탈로그에 있다 (새 코드는 error-codes.ts + 문서 표에 추가)', () => {
    expect([...thrown.keys()].filter((code) => !(code in ERROR_CODES)).sort()).toEqual([]);
  });

  it('카탈로그에만 있고 소스에서 던지지 않는 코드는 없다 (죽은 항목은 삭제)', () => {
    expect(catalog.filter((code) => !thrown.has(code))).toEqual([]);
  });

  it('카탈로그의 HTTP 상태는 소스의 예외 클래스가 내는 상태와 같다', () => {
    const mismatches = catalog
      .filter((code) => thrown.has(code))
      .filter((code) => JSON.stringify([...ERROR_CODES[code as keyof typeof ERROR_CODES].statuses]) !== JSON.stringify(thrown.get(code)))
      .map((code) => `${code}: 카탈로그 ${JSON.stringify(ERROR_CODES[code as keyof typeof ERROR_CODES].statuses)} / 소스 ${JSON.stringify(thrown.get(code))}`);
    expect(mismatches).toEqual([]);
  });

  it('모든 항목에 한 줄 의미가 있다', () => {
    expect(catalog.filter((code) => !ERROR_CODES[code as keyof typeof ERROR_CODES].ko.trim() || ERROR_CODES[code as keyof typeof ERROR_CODES].ko.includes('\n'))).toEqual([]);
  });

  it('docs/api-contract.md 코드 표가 카탈로그와 코드·상태·의미까지 같다', () => {
    const rows = docRows();
    expect([...rows.keys()].sort()).toEqual(catalog);
    const diffs = catalog
      .map((code) => ({ code, entry: ERROR_CODES[code as keyof typeof ERROR_CODES], row: rows.get(code)! }))
      .filter(({ entry, row }) => JSON.stringify([...entry.statuses]) !== JSON.stringify(row.statuses) || entry.ko !== row.ko)
      .map(({ code }) => code);
    expect(diffs).toEqual([]);
  });

  it('스캐너 자체 검증: 템플릿 접두사(INVALID_TRANSITION:${…})와 클래스별 상태를 읽는다', () => {
    expect(thrown.get('INVALID_TRANSITION')).toEqual([400]);
    expect(thrown.get('BOUNTY_NOT_FOUND')).toEqual([400, 404]);
    expect(thrown.get('DATABASE_UNAVAILABLE')).toEqual([503]);
  });
});
