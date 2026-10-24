import { PAYABLE_REWARD_STATUSES, PAYOUT_STATUSES, payoutStatusSql } from './payout-status';
import { PAYABLE_REWARD_STATUSES as FROM_SERVICE } from './rewards.service';

jest.mock('../nfts/nfts.service', () => ({ NftsService: class {} })); // rewards.service → nfts → ESM SDK

/** 동작 자체(5가지 경우)는 실 DB에서: src/test-db/users.db-spec.ts "payout status" */
describe('payoutStatusSql', () => {
  const sql = payoutStatusSql('s', 'b');

  it('answers exactly PAID / PARTIALLY_PAID / PENDING / NONE', () => {
    expect(PAYOUT_STATUSES).toEqual(['PAID', 'PARTIALLY_PAID', 'PENDING', 'NONE']);
    expect(sql).toContain("CASE WHEN count(*) = 0 THEN 'NONE'");
    expect(sql).toContain("WHEN count(*) FILTER (WHERE owed.paid) = count(*) THEN 'PAID'");
    expect(sql).toContain("WHEN count(*) FILTER (WHERE owed.paid) > 0 THEN 'PARTIALLY_PAID'");
    expect(sql).toContain("ELSE 'PENDING' END");
  });

  it('owed = funded rewards of the bounty with a payout row for this submission or remaining headroom; paid = a PAID payout for this submission', () => {
    expect(sql).toContain('WHERE rw.bounty_id = b.id');
    expect(sql).toContain("AND rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')");
    expect(sql).toContain('EXISTS (SELECT 1 FROM payout px WHERE px.bounty_reward_id = rw.id AND px.submission_id = s.id)');
    expect(sql).toContain('OR LEAST(rw.amount, rw.deposited_amount) >');
    expect(sql).toContain("(SELECT COALESCE(SUM(px.amount), 0) FROM payout px WHERE px.bounty_reward_id = rw.id AND px.status <> 'CANCELLED')");
    expect(sql).toMatch(/px\.submission_id = s\.id\s+AND px\.status = 'PAID'\) AS paid/);
    expect(sql).not.toMatch(/\$\d/); // no bind parameters — safe to embed in any query
  });

  it('uses the given aliases and refuses anything that is not an identifier', () => {
    expect(payoutStatusSql('sub', 'bo')).toContain('px.submission_id = sub.id');
    expect(payoutStatusSql('sub', 'bo')).toContain('rw.bounty_id = bo.id');
    expect(() => payoutStatusSql('s; DROP TABLE x', 'b')).toThrow('alias must be an identifier');
    expect(() => payoutStatusSql('s', 'b.id')).toThrow('alias must be an identifier');
  });

  it('shares the payable reward statuses with requestPayout', () => {
    expect(PAYABLE_REWARD_STATUSES).toEqual(['FUNDED', 'PARTIALLY_PAID', 'PAID']);
    expect(FROM_SERVICE).toBe(PAYABLE_REWARD_STATUSES);
  });
});
