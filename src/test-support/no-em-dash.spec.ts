import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { EXCLUDE_NOTHING, listSourceFiles } from './source-files';

/**
 * 운영자와 사용자가 읽는 문자열(스크립트 출력, 로그, 알림, 에러 메시지)에 em dash(U+2014)를 쓰지 않는다 (프로젝트 규칙).
 * 주석은 검사하지 않는다 - 줄 전체가 주석이 아닌 코드 줄만 본다.
 */
const EM_DASH = '\u2014';
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

describe('no em dash in runtime strings', () => {
  const root = join(__dirname, '..', '..');
  const files = [
    // scripts는 .js (모든 파일), src는 기본 규칙
    ...listSourceFiles(join(root, 'scripts'), { extensions: ['.js'], exclude: EXCLUDE_NOTHING }),
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

/**
 * 저장소에 추적되는 모든 텍스트 파일(소스, 문서, SQL, 설정)에 em dash(U+2014)를 쓰지 않는다 (워크스페이스 규칙).
 * 위 가드는 런타임 문자열만 보고, 이 가드는 주석과 문서까지 본다.
 * 예외는 아래 목록에 파일 경로를 **명시**한다 (지금은 없음). package-lock.json은 외부 패키지 메타데이터라 제외한다.
 */
const ALLOWED_FILES: string[] = [];
const IGNORED_FILES = new Set(['package-lock.json']);

describe('no em dash in tracked files', () => {
  const root = join(__dirname, '..', '..');
  let tracked: string[] | null = null;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    tracked = null; // git 없는 환경(소스 압축본)에서는 건너뛴다
  }

  const run = tracked ? it : it.skip;
  run('has no U+2014 in any tracked text file (except the explicit allowlist)', () => {
    const offenders: string[] = [];
    for (const rel of tracked ?? []) {
      if (IGNORED_FILES.has(rel) || ALLOWED_FILES.includes(rel)) continue;
      const full = join(root, rel);
      if (!existsSync(full)) continue; // 워킹 트리에서 삭제된 파일
      const text = readFileSync(full, 'utf8');
      if (text.includes(EM_DASH)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  run('every allowlisted file still exists and still needs the exception', () => {
    for (const rel of ALLOWED_FILES) expect(readFileSync(join(root, rel), 'utf8')).toContain(EM_DASH);
  });
});
