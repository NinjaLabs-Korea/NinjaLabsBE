import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALLOCATED_PAYOUT_STATUSES, allocatedPayoutSumSql, AWAITING_APPROVAL_PAYOUT_STATUSES, OPEN_PAYOUT_STATUSES, owesUnpaidRewardSql,
  PAYABLE_REWARD_STATUSES, paidPayoutSumSql, PAYOUT_ROW_STATUSES, PAYOUT_STATUSES, payoutStatusSql, rewardCapSql, rewardHeadroomSql,
  SENDABLE_PAYOUT_STATUSES, sqlStatusList, TERMINAL_PAYOUT_STATUSES, UNSETTLED_PAYOUT_STATUSES,
} from './payout-status';

jest.mock('../nfts/nfts.service', () => ({ NftsService: class {} })); // rewards.service → nfts → ESM SDK

/** 동작 자체는 실 DB에서: src/test-db/users.db-spec.ts "payout status", src/test-db/bounty-flow.db-spec.ts "cancelled payout" */
describe('payoutStatusSql', () => {
  const sql = payoutStatusSql('s', 'b');

  it('answers exactly PAID / PARTIALLY_PAID / PENDING / NONE', () => {
    expect(PAYOUT_STATUSES).toEqual(['PAID', 'PARTIALLY_PAID', 'PENDING', 'NONE']);
    expect(sql).toContain("CASE WHEN count(*) = 0 THEN 'NONE'");
    expect(sql).toContain("WHEN count(*) FILTER (WHERE owed.paid) = count(*) THEN 'PAID'");
    expect(sql).toContain("WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PARTIALLY_PAID'");
    expect(sql).toContain("ELSE 'PENDING' END");
  });

  it('owed = funded rewards with an allocated payout row for this submission, or no row at all and remaining headroom; paid = a PAID payout', () => {
    expect(sql).toContain('WHERE rw.bounty_id = b.id');
    expect(sql).toContain("AND rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')");
    // (a) 이 제출의 배정된(취소 아닌) payout 행
    expect(sql).toContain("EXISTS (SELECT 1 FROM payout px WHERE px.bounty_reward_id = rw.id AND px.submission_id = s.id AND px.status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING', 'PAID', 'FAILED'))");
    // (b) 행이 하나도 없고(취소된 행도 없음 — requestPayout이 409로 다시 받지 않는다) 여유분이 남음
    expect(sql).toContain('OR (NOT EXISTS (SELECT 1 FROM payout px WHERE px.bounty_reward_id = rw.id AND px.submission_id = s.id)');
    expect(sql).toContain(`AND ${rewardHeadroomSql('rw', 'px')}`);
    expect(sql).toMatch(/px\.submission_id = s\.id\s+AND px\.status = 'PAID'\) AS paid/);
    expect(sql).not.toMatch(/\$\d/); // no bind parameters — safe to embed in any query
  });

  it('owesUnpaidRewardSql is exactly "payoutStatusSql is PENDING or PARTIALLY_PAID" — the COMPLETED blocker and the response agree', () => {
    expect(owesUnpaidRewardSql('s', 'b')).toBe(`${payoutStatusSql('s', 'b')} IN ('PENDING', 'PARTIALLY_PAID')`);
  });

  it('uses the given aliases and refuses anything that is not an identifier', () => {
    expect(payoutStatusSql('sub', 'bo')).toContain('px.submission_id = sub.id');
    expect(payoutStatusSql('sub', 'bo')).toContain('rw.bounty_id = bo.id');
    expect(() => payoutStatusSql('s; DROP TABLE x', 'b')).toThrow('alias must be an identifier');
    expect(() => payoutStatusSql('s', 'b.id')).toThrow('alias must be an identifier');
  });

  it('shares the payable reward statuses with requestPayout', () => {
    expect(PAYABLE_REWARD_STATUSES).toEqual(['FUNDED', 'PARTIALLY_PAID', 'PAID']);
  });
});

/**
 * payout 상태 집합 — 이 표가 규칙의 문서다. 바꾸려면 payout-status.ts 하나만 고치고, 아래 기대값과 그 파일 머리 주석의 목록을 같이 고친다.
 */
describe('payout status sets', () => {
  const sorted = (list: readonly string[]) => [...list].sort();

  it('PAYOUT_ROW_STATUSES is exactly the payout.status CHECK in the migration', () => {
    const migration = readFileSync(join(__dirname, '../../supabase/migrations/0006_rewards.sql'), 'utf8');
    const table = migration.slice(migration.indexOf('CREATE TABLE payout'));
    const check = /CHECK \(status IN \(([^)]*)\)\)/.exec(table)![1];
    expect(sorted(check.split(',').map((v) => v.trim().replace(/'/g, '')))).toEqual(sorted(PAYOUT_ROW_STATUSES));
  });

  it('open (in flight) and terminal partition every payout status', () => {
    expect(OPEN_PAYOUT_STATUSES).toEqual(['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING']);
    expect(TERMINAL_PAYOUT_STATUSES).toEqual(['PAID', 'CANCELLED', 'FAILED']);
    expect(sorted([...OPEN_PAYOUT_STATUSES, ...TERMINAL_PAYOUT_STATUSES])).toEqual(sorted(PAYOUT_ROW_STATUSES));
    expect(OPEN_PAYOUT_STATUSES.filter((s) => (TERMINAL_PAYOUT_STATUSES as readonly string[]).includes(s))).toEqual([]);
    expect(sorted([...AWAITING_APPROVAL_PAYOUT_STATUSES, ...SENDABLE_PAYOUT_STATUSES])).toEqual(sorted(OPEN_PAYOUT_STATUSES));
  });

  it('only CANCELLED releases its allocation; FAILED stays allocated (and unsettled) until an operator closes it', () => {
    expect(sorted(ALLOCATED_PAYOUT_STATUSES)).toEqual(sorted(PAYOUT_ROW_STATUSES.filter((s) => s !== 'CANCELLED')));
    expect(sorted(UNSETTLED_PAYOUT_STATUSES)).toEqual(sorted(ALLOCATED_PAYOUT_STATUSES.filter((s) => s !== 'PAID')));
  });

  it('renders the cap, allocated / paid sums and headroom from those sets', () => {
    expect(rewardCapSql('rw')).toBe('LEAST(rw.amount, rw.deposited_amount)');
    expect(allocatedPayoutSumSql('rw', 'p')).toBe(
      `(SELECT COALESCE(SUM(p.amount), 0) FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status IN (${sqlStatusList(ALLOCATED_PAYOUT_STATUSES)}))`);
    expect(paidPayoutSumSql('r', 'x')).toBe("(SELECT COALESCE(SUM(x.amount), 0) FROM payout x WHERE x.bounty_reward_id = r.id AND x.status = 'PAID')");
    expect(rewardHeadroomSql('rw', 'p')).toBe(`${rewardCapSql('rw')} > ${allocatedPayoutSumSql('rw', 'p')}`);
    expect(() => rewardCapSql('rw; --')).toThrow('alias must be an identifier');
  });

  it('sqlStatusList only renders upper-case status constants', () => {
    expect(sqlStatusList(['PAID', 'FAILED'])).toBe("'PAID', 'FAILED'");
    expect(() => sqlStatusList([])).toThrow();
    expect(() => sqlStatusList(["PAID'); DROP TABLE payout; --"])).toThrow();
  });
});

/**
 * src 밖 사본 — scripts/는 src를 import하지 않는 독립 JS/SQL이라 집합을 복사해 둔다. 여기서 어긋나면 실패한다:
 * payout-status.ts를 바꿨다면 아래 파일의 사본(주석으로 표시됨)도 같이 고친다.
 */
describe('script copies of the payout status sets match payout-status.ts', () => {
  const sorted = (list: readonly string[]) => [...list].sort();

  it('scripts/record-refund.js refuses on exactly the non-terminal payouts', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const script = require('../../scripts/record-refund') as { TERMINAL_PAYOUT_STATUSES: string[] };
    expect(sorted(script.TERMINAL_PAYOUT_STATUSES)).toEqual(sorted(TERMINAL_PAYOUT_STATUSES));
  });

  it('scripts/mainnet-preflight.sql [blocker] 3 payout_open lists exactly the terminal statuses', () => {
    const sql = readFileSync(join(__dirname, '../../scripts/mainnet-preflight.sql'), 'utf8');
    const block = sql.slice(sql.indexOf("'payout_open'"));
    const list = /p\.status NOT IN \(([^)]*)\)/.exec(block.slice(0, block.indexOf(';')))![1];
    expect(sorted(list.split(',').map((v) => v.trim().replace(/'/g, '')))).toEqual(sorted(TERMINAL_PAYOUT_STATUSES));
  });
});
