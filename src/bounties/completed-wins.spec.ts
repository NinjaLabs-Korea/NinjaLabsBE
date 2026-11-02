import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { payoutRequestableSql, payoutStatusSql } from '../rewards/payout-status';
import { PENDING_REWARD_SQL } from '../users/account-withdrawal.service';
import { listSourceFiles } from '../test-support/source-files';
import { completedBountySql, completedWinSql } from './completed-wins';

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('completed wins and payout requestable fragments', () => {
  it('render the conditions the call sites used before', () => {
    expect(completedWinSql('s', 'b')).toBe(`s.status = 'APPROVED' AND b.deleted_at IS NULL`);
    expect(completedBountySql('')).toBe(`status = 'COMPLETED' AND deleted_at IS NULL`);
    expect(() => completedWinSql('s', '')).toThrow('both aliases');
    expect(() => completedWinSql('', 'b')).toThrow('completedWinSql: both aliases are required');
    expect(completedWinSql()).toBe(completedWinSql('s', 'b'));
    expect(completedBountySql()).toBe(`b.status = 'COMPLETED' AND b.deleted_at IS NULL`);
    // 별칭은 문장에 그대로 들어간다: 식별자가 아니면 거부하고 오류가 호출한 조각 함수를 가리킨다
    expect(() => completedWinSql('s;', 'b')).toThrow('completedWinSql: alias must be an identifier');
    expect(() => completedWinSql('s', 'b b')).toThrow('completedWinSql: alias must be an identifier');
    expect(() => completedBountySql('b;')).toThrow('completedBountySql: alias must be an identifier');
    expect(payoutRequestableSql('rw', 's', 'p')).toBe(
      'NOT EXISTS (SELECT 1 FROM payout p WHERE p.bounty_reward_id = rw.id AND p.submission_id = s.id) '
      + 'AND LEAST(rw.amount, rw.deposited_amount) > (SELECT COALESCE(SUM(p.amount), 0) FROM payout p WHERE p.bounty_reward_id = rw.id '
      + "AND p.status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'PAID', 'FAILED'))",
    );
  });

  it('payout status and the withdrawal block both embed the same requestable fragment', () => {
    expect(flat(payoutStatusSql('s', 'b'))).toContain(flat(payoutRequestableSql('rw', 's', 'px')));
    expect(flat(PENDING_REWARD_SQL)).toContain(flat(payoutRequestableSql('rw', 's', 'p')));
  });

  it('no hand-written copies of the completed-win condition in server code', () => {
    const SRC_ROOT = join(__dirname, '..');
    const copy = /s\.status = 'APPROVED' AND b\.deleted_at IS NULL|status = 'COMPLETED' AND deleted_at IS NULL/;
    const offenders = listSourceFiles(SRC_ROOT, { include: /^(?!test-|bounties\/completed-wins\.ts$)/ })
      .filter((file) => copy.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
