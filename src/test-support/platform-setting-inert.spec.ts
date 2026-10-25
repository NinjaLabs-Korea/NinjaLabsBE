import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * 정적 가드 — 서버 코드는 `platform_setting` 테이블을 읽지 않는다. 그래서 scripts/mainnet-preflight.sql 점검 8과 docs/runbook.md §8.1은
 * 그 값(`onboarding.nft_mint_enabled` 등)을 "민팅 스위치가 아니다"라고 안내한다 (운영자가 끄면 멈춘다고 믿고 전환하지 않게).
 * 코드가 이 테이블을 읽기 시작하면 이 테스트가 실패한다 — 그때 위 두 안내를 실제 동작에 맞게 고치고 여기서 해당 파일을 허용한다.
 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.ts$/.test(entry) && !/\.(spec|db-spec|e2e-spec|d)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

describe('platform_setting is not read by the server', () => {
  it('no non-test source file references the platform_setting table', () => {
    const srcDir = join(__dirname, '..');
    const readers = listSourceFiles(srcDir)
      .filter((file) => /platform_setting/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcDir, file));
    expect(readers).toEqual([]);
  });
});
