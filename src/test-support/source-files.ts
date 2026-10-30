import { readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * 정적 가드(*.spec.ts)가 공유하는 소스 파일 목록 - 가드마다 워커를 복사하면 필터가 서로 어긋난다
 * (sql-param-casts는 e2e-spec을 읽고, jwt-algorithm은 경로의 'test-'로 거르고 .d.ts를 읽었다).
 * 스펙 파일이 아니라서 import해도 테스트가 따로 등록되지 않는다.
 *
 * 기본값: root 아래 .ts 파일에서 `.spec.ts` `.db-spec.ts` `.e2e-spec.ts` `.d.ts`와 node_modules를 뺀 것, 정렬됨.
 * 가드가 다른 범위를 봐야 하면 옵션으로 **명시**한다 (왜 다른지 그 가드 옆에 한 줄 남긴다):
 *   - extensions: 기본 ['.ts']
 *   - include:    root 기준 상대 경로(항상 '/' 구분)가 맞아야 한다
 *   - exclude:    기본 제외 규칙을 **대체**한다. 예외를 하나 더하려면 DEFAULT_EXCLUDE를 합쳐 쓴다
 */
export const DEFAULT_EXCLUDE = /\.(?:spec|db-spec|e2e-spec|d)\.ts$/;

/** `exclude` 옵션에 넘기면 기본 제외 규칙을 끄고 아무것도 거르지 않는다 (항상 실패하는 lookahead) */
export const EXCLUDE_NOTHING = /(?!)/;

export interface SourceFileOptions {
  include?: RegExp;
  exclude?: RegExp;
  extensions?: string[];
}

export function listSourceFiles(root: string, opts: SourceFileOptions = {}): string[] {
  const { include, exclude = DEFAULT_EXCLUDE, extensions = ['.ts'] } = opts;
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules') walk(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join('/');
      if (!extensions.some((ext) => entry.endsWith(ext))) continue;
      if (exclude.test(rel) || (include && !include.test(rel))) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
