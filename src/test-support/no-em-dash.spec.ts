import { readFileSync } from 'fs';
import { join } from 'path';
import { listSourceFiles } from './source-files';

/**
 * 운영자와 사용자가 읽는 문자열(스크립트 출력, 로그, 알림, 에러 메시지)에 em dash(U+2014)를 쓰지 않는다 (프로젝트 규칙).
 * 주석은 검사하지 않는다 - 줄 전체가 주석이 아닌 코드 줄만 본다.
 */
const EM_DASH = '—';
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

describe('no em dash in runtime strings', () => {
  const root = join(__dirname, '..', '..');
  const files = [
    // scripts는 .js (모든 파일), src는 기본 규칙
    ...listSourceFiles(join(root, 'scripts'), { extensions: ['.js'], exclude: /$^/ }),
    ...listSourceFiles(join(root, 'src')),
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
