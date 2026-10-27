import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * 운영자와 사용자가 읽는 문자열(스크립트 출력, 로그, 알림, 에러 메시지)에 em dash(U+2014)를 쓰지 않는다 (프로젝트 규칙).
 * 주석은 검사하지 않는다 - 줄 전체가 주석이 아닌 코드 줄만 본다.
 */
const EM_DASH = '—';
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') walk(full, accept, out);
    } else if (accept(full)) out.push(full);
  }
  return out;
}

describe('no em dash in runtime strings', () => {
  const root = join(__dirname, '..', '..');
  const files = [
    ...walk(join(root, 'scripts'), (f) => f.endsWith('.js')),
    ...walk(join(root, 'src'), (f) => f.endsWith('.ts') && !/\.(spec|db-spec|e2e-spec)\.ts$/.test(f)),
  ];

  it('scans a non-trivial set of files', () => expect(files.length).toBeGreaterThan(50));

  it('has no U+2014 on code lines of scripts/*.js and non-test src files', () => {
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (line.includes(EM_DASH) && !COMMENT_LINE.test(line)) offenders.push(`${file.slice(root.length + 1)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
