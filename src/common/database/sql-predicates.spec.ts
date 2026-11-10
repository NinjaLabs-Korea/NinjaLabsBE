import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { listSourceFiles } from '../../test-support/source-files';
import { activeUserSql } from '../../users/active-user';
import { sqlColumnPrefix, sqlParam } from './sql-alias';

/**
 * 술어 조각이 단일 출처로 옮기기 전 각 호출부의 SQL과 **글자 그대로** 같게 렌더링되는지 고정한다(동작 불변의 근거).
 * activeUserSql만 몇몇 호출부에서 두 조건의 순서가 바뀌었다(`deleted_at IS NULL AND status = 'ACTIVE'` -> 반대): AND는 교환 가능하고
 * 두 조건 모두 부작용 없는 컬럼 비교라 결과가 같다. 실제 행에 대한 판정은 src/test-db/sql-predicates.db-spec.ts.
 */
describe('SQL predicate fragments', () => {
  it('activeUserSql: aliased and bare forms', () => {
    expect(activeUserSql('u')).toBe(`u.status = 'ACTIVE' AND u.deleted_at IS NULL`);
    expect(activeUserSql()).toBe(`u.status = 'ACTIVE' AND u.deleted_at IS NULL`);
    expect(activeUserSql('')).toBe(`status = 'ACTIVE' AND deleted_at IS NULL`);
  });

  it('aliases and placeholders must be identifiers / $n (they are pasted into SQL)', () => {
    expect(() => sqlColumnPrefix('u; DROP', 'x')).toThrow('alias must be an identifier');
    expect(() => activeUserSql('U')).toThrow('alias must be an identifier');
    expect(() => sqlParam('1', 'x')).toThrow('bind placeholder');
    expect(sqlParam('$12', 'x')).toBe('$12');
  });
});

describe('no new copies of the predicates outside their single source', () => {
  const SRC_ROOT = join(__dirname, '..', '..');
  const HOMES = ['users/active-user.ts'];
  // 세 번째 값은 그 패턴을 예외로 허용하는 파일(없으면 HOMES만)
  const COPIES: Array<[string, RegExp, string[]?]> = [
    // ownedAgentIdsSql/participantUserIdSql(agents/owned-agents.ts)은 에이전트 모듈과 함께 지웠다(BE PR4). 앱 코드가 에이전트 소유 조건을 다시 쓰지 않게 남겨 둔다
    ['owned agent id subquery (removed with the agents module)', /SELECT id FROM agent WHERE owner_user_id = \$\d/],
    ['participant owner COALESCE (removed with the agents module)', /COALESCE\(\w+\.(?:submitter|applicant)_user_id, \(SELECT \w+\.owner_user_id FROM agent/],
    // 더 넓은 그물: 모양이 달라도 agent 테이블을 읽거나 agent_id 컬럼을 거는 SQL은 앱 코드에 없어야 한다. 예외는 과거 행을 보여 주는 감사 로그 목록 하나뿐
    ['agent table read in app SQL (removed with the agents module; only the audit history list may)', /\b(?:FROM|JOIN)\s+agent\b(?!_)/i, ['audit/audit.service.ts']],
    ['agent_id column condition in app SQL (removed with the agents module)', /(?:\b\w+\.agent_id\b|\bagent_id\s+(?:IS|=|IN)\b)/i],
    ['active user condition (activeUserSql)', /(?<![\w.])(?:u\.)?(?:status = 'ACTIVE' AND (?:u\.)?deleted_at IS NULL|deleted_at IS NULL AND (?:u\.)?status = 'ACTIVE')/],
    // primaryWalletSql(wallets/primary-wallet.ts)은 지갑 모듈과 함께 지웠다(BE PR2). 앱 코드가 대표 지갑을 다시 고르지 않게 남겨 둔다
    ['primary wallet condition (removed with the wallets module)', /is_primary = true AND (?:\w+\.)?disconnected_at IS NULL/],
  ];

  it.each(COPIES)('%s is written only in its helper', (_name, pattern, allowed = []) => {
    // 테스트 픽스처(test-db, test-e2e, test-support)는 행을 직접 만들고 읽으므로 대상이 아니다
    const offenders = listSourceFiles(SRC_ROOT, { include: /^(?!test-)/ })
      .map((file) => relative(SRC_ROOT, file).split('\\').join('/'))
      .filter((rel) => !HOMES.includes(rel) && !allowed.includes(rel) && pattern.test(readFileSync(join(SRC_ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
