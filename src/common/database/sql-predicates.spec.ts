import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { ownedAgentIdsSql, participantUserIdSql } from '../../agents/owned-agents';
import { listSourceFiles } from '../../test-support/source-files';
import { activeUserSql } from '../../users/active-user';
import { primaryWalletSql } from '../../wallets/primary-wallet';
import { sqlColumnPrefix, sqlParam } from './sql-alias';

/**
 * 술어 조각이 단일 출처로 옮기기 전 각 호출부의 SQL과 **글자 그대로** 같게 렌더링되는지 고정한다(동작 불변의 근거).
 * activeUserSql만 몇몇 호출부에서 두 조건의 순서가 바뀌었다(`deleted_at IS NULL AND status = 'ACTIVE'` -> 반대): AND는 교환 가능하고
 * 두 조건 모두 부작용 없는 컬럼 비교라 결과가 같다. 실제 행에 대한 판정은 src/test-db/sql-predicates.db-spec.ts.
 */
describe('SQL predicate fragments', () => {
  it('ownedAgentIdsSql renders the two pre-existing owner subqueries exactly', () => {
    expect(ownedAgentIdsSql('$1', 'live')).toBe('ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL)');
    expect(ownedAgentIdsSql('$2', 'live')).toBe('ARRAY(SELECT id FROM agent WHERE owner_user_id = $2 AND deleted_at IS NULL)');
    expect(ownedAgentIdsSql('$1', 'including-deleted')).toBe('ARRAY(SELECT id FROM agent WHERE owner_user_id = $1)');
  });

  it('participantUserIdSql renders the payout recipient and lifecycle applicant forms exactly', () => {
    expect(participantUserIdSql('s', 'submitter_user_id', 'ax'))
      .toBe('COALESCE(s.submitter_user_id, (SELECT ax.owner_user_id FROM agent ax WHERE ax.id = s.agent_id))');
    expect(participantUserIdSql('a', 'applicant_user_id', 'ag'))
      .toBe('COALESCE(a.applicant_user_id, (SELECT ag.owner_user_id FROM agent ag WHERE ag.id = a.agent_id))');
    expect(() => participantUserIdSql('s', 'submitter_user_id', '')).toThrow('both aliases');
  });

  it('activeUserSql: aliased and bare forms', () => {
    expect(activeUserSql('u')).toBe(`u.status = 'ACTIVE' AND u.deleted_at IS NULL`);
    expect(activeUserSql()).toBe(`u.status = 'ACTIVE' AND u.deleted_at IS NULL`);
    expect(activeUserSql('')).toBe(`status = 'ACTIVE' AND deleted_at IS NULL`);
  });

  it('primaryWalletSql: aliased and bare forms', () => {
    expect(primaryWalletSql('w')).toBe('w.is_primary = true AND w.disconnected_at IS NULL');
    expect(primaryWalletSql('')).toBe('is_primary = true AND disconnected_at IS NULL');
  });

  it('aliases and placeholders must be identifiers / $n (they are pasted into SQL)', () => {
    expect(() => sqlColumnPrefix('u; DROP', 'x')).toThrow('alias must be an identifier');
    expect(() => activeUserSql('U')).toThrow('alias must be an identifier');
    expect(() => sqlParam('1', 'x')).toThrow('bind placeholder');
    expect(() => ownedAgentIdsSql('$0', 'live')).toThrow('bind placeholder');
    expect(sqlParam('$12', 'x')).toBe('$12');
  });
});

describe('no new copies of the predicates outside their single source', () => {
  const SRC_ROOT = join(__dirname, '..', '..');
  const HOMES = ['agents/owned-agents.ts', 'users/active-user.ts', 'wallets/primary-wallet.ts'];
  const COPIES: Array<[string, RegExp]> = [
    ['owned agent id subquery (ownedAgentIdsSql)', /SELECT id FROM agent WHERE owner_user_id = \$\d/],
    ['participant owner COALESCE (participantUserIdSql)', /COALESCE\(\w+\.(?:submitter|applicant)_user_id, \(SELECT \w+\.owner_user_id FROM agent/],
    ['active user condition (activeUserSql)', /(?<![\w.])(?:u\.)?(?:status = 'ACTIVE' AND (?:u\.)?deleted_at IS NULL|deleted_at IS NULL AND (?:u\.)?status = 'ACTIVE')/],
    ['primary wallet condition (primaryWalletSql)', /is_primary = true AND (?:\w+\.)?disconnected_at IS NULL/],
  ];

  it.each(COPIES)('%s is written only in its helper', (_name, pattern) => {
    // 테스트 픽스처(test-db, test-e2e, test-support)는 행을 직접 만들고 읽으므로 대상이 아니다
    const offenders = listSourceFiles(SRC_ROOT, { include: /^(?!test-)/ })
      .map((file) => relative(SRC_ROOT, file).split('\\').join('/'))
      .filter((rel) => !HOMES.includes(rel) && pattern.test(readFileSync(join(SRC_ROOT, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
