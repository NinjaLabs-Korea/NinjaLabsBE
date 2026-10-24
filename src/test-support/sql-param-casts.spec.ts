import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * 정적 가드 — 같은 SQL 문장 안에서 같은 `$n`이 서로 다른 타입으로 추론되게 쓰였는지 검사한다 (README "코드 배치 규칙").
 *
 * node-pg는 파라미터 타입을 보내지 않으므로 Postgres가 문맥에서 추론한다. 한 문장에서 같은 `$n`이
 *   (a) 한 번은 `$n::type`, 한 번은 bare로,
 *   (b) 서로 다른 캐스트로,
 *   (c) bare인 채로 컬럼 대입/비교(`status = $n`, varchar)와 문자열 리터럴 비교(`$n = 'X'` / `CASE WHEN $n`, text)에 함께
 * 쓰이면 `42P08 inconsistent types deduced for parameter`로 거부된다 — mock DB 유닛 테스트는 이를 절대 잡지 못한다
 * (nft-job.worker.ts의 실패 경로가 그렇게 운영에서 터졌다). 해결은 모든 자리를 같은 캐스트로 통일하는 것 (`$2::varchar` …).
 *
 * 의도적으로 다르게 써야 하면 문장 안에 `-- sql-params-ok: <이유>`를 넣어 건너뛴다 (이유 없는 opt-out은 실패).
 */

const SRC_ROOT = join(__dirname, '..');
const SQL_KEYWORD = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|VALUES|MERGE)\b/i;
const OPT_OUT = /--\s*sql-params-ok\b[:\s-]*([^\n]*)/;
/** `$n` 또는 `$n::type` — `::`가 바로 붙은 캐스트만 그 자리의 캐스트로 본다 */
const PARAM = /\$(\d+)(?:::(\w+(?:\[\])?))?/g;
/** `$n = <여기>`에서 컬럼이 아닌 것들 */
const NOT_A_COLUMN = new Set(['ANY', 'ALL', 'SOME', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IS', 'IN', 'INTERVAL', 'NOW']);

export type Finding = { param: number; reason: string };

export function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') listSourceFiles(full, out);
    } else if (/\.ts$/.test(entry) && !/\.(spec|db-spec|d)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * 소스에서 문자열/템플릿 리터럴을 꺼낸다 (주석은 건너뛴다). 템플릿의 `${…}`는 중첩 깊이를 세어 넘기고,
 * 그 안의 리터럴도 재귀적으로 꺼낸다. 정규식 리터럴은 따로 인식하지 않는다 — 따옴표류 문자열은 줄을 넘지 못하므로
 * 정규식 안의 따옴표가 섞여도 피해는 그 줄로 끝난다.
 */
export function extractLiterals(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const lineAt = (index: number) => source.slice(0, index).split('\n').length;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"') {
      const start = i;
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      if (source[j] === c) {
        out.push({ text: source.slice(start + 1, j), line: lineAt(start) });
        i = j + 1;
      } else {
        i = start + 1; // 닫히지 않음(정규식 등) — 문자열이 아니었던 것으로 본다
      }
    } else if (c === '`') {
      const start = i;
      let j = i + 1;
      let text = '';
      while (j < n && source[j] !== '`') {
        if (source[j] === '\\') { text += source.slice(j, j + 2); j += 2; continue; }
        if (source[j] === '$' && source[j + 1] === '{') {
          const close = matchBrace(source, j + 1);
          for (const nested of extractLiterals(source.slice(j + 2, close))) out.push({ ...nested, line: lineAt(j) + nested.line - 1 });
          text += '${…}';
          j = close + 1;
          continue;
        }
        text += source[j++];
      }
      out.push({ text, line: lineAt(start) });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** `{`의 짝 `}` 인덱스 — 사이의 문자열/템플릿/주석은 건너뛴다 */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return i; }
    else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') { j += 2; continue; }
        if (c === '`' && source[j] === '$' && source[j + 1] === '{') { j = matchBrace(source, j + 1) + 1; continue; }
        j++;
      }
      i = j;
    } else if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return source.length;
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2) + 1;
    }
    i++;
  }
  return source.length;
}

function identifierBefore(before: string): string | null {
  const m = before.match(/([A-Za-z_][\w.]*)\s*(?:=|<>|!=|<=|>=|<|>)\s*$/);
  return m ? m[1] : null;
}

function identifierAfter(after: string): string | null {
  const m = after.match(/^\s*(?:=|<>|!=|<=|>=|<|>)\s*([A-Za-z_][\w.]*)(?!\s*\()/);
  return m ? m[1] : null;
}

function isColumn(identifier: string | null): boolean {
  return identifier !== null && !NOT_A_COLUMN.has(identifier.toUpperCase());
}

/** 문장 하나를 검사한다 — SQL로 보이지 않거나 `$n`이 없으면 빈 배열 */
export function analyzeStatement(sql: string): Finding[] {
  if (!/\$\d/.test(sql) || !SQL_KEYWORD.test(sql)) return [];
  const optOut = sql.match(OPT_OUT);
  if (optOut) {
    return optOut[1].trim() ? [] : [{ param: 0, reason: '`-- sql-params-ok` needs a reason (`-- sql-params-ok: why`)' }];
  }
  const params = new Map<number, { casts: Set<string>; bare: number; column: boolean; literal: boolean }>();
  for (const match of sql.matchAll(PARAM)) {
    const param = Number(match[1]);
    const cast = match[2]?.toLowerCase();
    const entry = params.get(param) ?? { casts: new Set<string>(), bare: 0, column: false, literal: false };
    params.set(param, entry);
    if (cast) { entry.casts.add(cast); continue; }
    entry.bare++;
    const before = sql.slice(0, match.index);
    const after = sql.slice(match.index! + match[0].length);
    if (/'\s*(?:=|<>|!=)\s*$/.test(before) || /^\s*(?:=|<>|!=)\s*'/.test(after) || /\bWHEN\s*$/i.test(before)) entry.literal = true;
    if (isColumn(identifierBefore(before)) || isColumn(identifierAfter(after))) entry.column = true;
  }
  const findings: Finding[] = [];
  for (const [param, entry] of [...params.entries()].sort(([a], [b]) => a - b)) {
    const casts = [...entry.casts];
    if (casts.length > 1) findings.push({ param, reason: `used with different casts (${casts.map((c) => `::${c}`).join(', ')})` });
    else if (casts.length === 1 && entry.bare > 0) findings.push({ param, reason: `used both as $${param}::${casts[0]} and bare` });
    else if (casts.length === 0 && entry.column && entry.literal) {
      findings.push({ param, reason: `bare in both a column assignment/comparison and a string-literal comparison (deduces varchar vs text) — cast every use, e.g. $${param}::varchar` });
    }
  }
  return findings;
}

export function scanFile(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const literal of extractLiterals(source)) {
    for (const finding of analyzeStatement(literal.text)) {
      out.push(`${relative(SRC_ROOT, file)}:${literal.line} $${finding.param}: ${finding.reason}`);
    }
  }
  return out;
}

describe('SQL parameter cast consistency (static guard for 42P08)', () => {
  it('flags the same $n used once cast and once bare', () => {
    expect(analyzeStatement(`INSERT INTO t (a, b) VALUES ($1::varchar, CASE WHEN $1 IS NULL THEN 0 ELSE 1 END)`))
      .toEqual([{ param: 1, reason: 'used both as $1::varchar and bare' }]);
  });

  it('flags the same $n used with two different casts', () => {
    expect(analyzeStatement(`SELECT $1::text, $1::uuid`)).toEqual([{ param: 1, reason: 'used with different casts (::text, ::uuid)' }]);
  });

  it('flags a bare $n used both against a column and against a string literal (the nft_job failure-path shape)', () => {
    const findings = analyzeStatement(`UPDATE nft_job SET status = $2, scheduled_at = CASE WHEN $2 = 'PENDING' THEN now() ELSE scheduled_at END WHERE id = $1`);
    expect(findings).toHaveLength(1);
    expect(findings[0].param).toBe(2);
    expect(analyzeStatement(`UPDATE t SET status = $2 WHERE id = $1 AND 'PENDING' = $2`)).toHaveLength(1);
    expect(analyzeStatement(`UPDATE t SET status = $2 WHERE id = $1 AND CASE WHEN $2 THEN true END`)).toHaveLength(1);
  });

  it('accepts uniform casts, single uses, bare column-only uses and non-SQL strings', () => {
    expect(analyzeStatement(`UPDATE t SET status = $2::varchar, processed_at = CASE WHEN $2::varchar = 'FAILED' THEN now() END WHERE id = $1`)).toEqual([]);
    expect(analyzeStatement(`UPDATE t SET a = $1, b = $1 WHERE id = $2 AND c = $2`)).toEqual([]);
    expect(analyzeStatement(`SELECT 1 WHERE id = ANY($1::uuid[]) OR parent = ANY($1::uuid[])`)).toEqual([]);
    expect(analyzeStatement(`price is $1 and $1 again`)).toEqual([]); // not SQL
  });

  it('honours an opt-out only when it carries a reason', () => {
    const sql = `UPDATE t SET status = $2 WHERE id = $1 AND $2 = 'X'`;
    expect(analyzeStatement(`${sql} -- sql-params-ok: column is text, both sides deduce text`)).toEqual([]);
    expect(analyzeStatement(`${sql} -- sql-params-ok`)).toEqual([{ param: 0, reason: '`-- sql-params-ok` needs a reason (`-- sql-params-ok: why`)' }]);
  });

  it('extracts template literals (with ${} interpolations and nested templates) and skips comments', () => {
    const source = [
      `// 'not a string' and \`not a template\``,
      `/* "block" */ const a = 'single'; const b = "double";`,
      'const c = `multi\nline ${x ? `inner ${y}` : "alt"} tail`;',
    ].join('\n');
    expect(extractLiterals(source).map((l) => l.text)).toEqual(['single', 'double', 'inner ${…}', 'alt', 'multi\nline ${…} tail']);
  });

  it('finds no inconsistently typed parameters in any SQL statement under src/', () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(10);
    const findings = files.flatMap(scanFile);
    expect(findings).toEqual([]);
  });
});
