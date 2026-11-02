import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { listSourceFiles } from '../test-support/source-files';

/**
 * 정적 가드 - multer `fileFilter`를 쓰지 않는다. audit-allowlist.json의 GHSA-q7qp-rjg7-q26m(multer 2.4.0, async fileFilter DoS)을
 * "도달 불가"로 둔 근거가 이것이다. 업로드 라우트는 운영자(`POST /admin/media`)와 회원 프로필 사진(`POST /users/me/avatar`) 둘이고
 * 회원 라우트는 누구나 부를 수 있다. fileFilter가 필요해지면 먼저 multer를 고친 버전으로 올리고 allowlist 항목과 이 가드를 지운다.
 */
describe('no multer fileFilter (audit allowlist premise)', () => {
  const FILE_FILTER = /\bfileFilter\b/;

  it('the pattern also catches shorthand, assignment and quoted forms (not only `fileFilter:`)', () => {
    for (const code of ['{ fileFilter }', 'opts.fileFilter = f', "{ 'fileFilter': f }", '{ fileFilter: f }']) expect(code).toMatch(FILE_FILTER);
    expect('{ fileSize: 1 }').not.toMatch(FILE_FILTER);
  });

  it('no source file passes a fileFilter option', () => {
    const root = join(__dirname, '..');
    const offenders = listSourceFiles(root)
      .filter((file) => FILE_FILTER.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
