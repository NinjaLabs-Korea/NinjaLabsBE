import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { RewardsService } from './rewards.service';

/**
 * 유닛 스펙은 트랜잭션을 열기 전에 끝나는 검사(해시/금액 형식)와 2인 승인 정책(설정 해석)만 다룬다.
 * SQL이 하는 일(해시 재사용, 상태 전이, 잠금, 상한 계산)은 실 Postgres 스펙이 고정한다:
 *   src/test-db/mark-paid-rules.db-spec.ts, bounty-flow.db-spec.ts, bounty-rules.db-spec.ts.
 * 여기 mock은 SQL 문장을 들여다보지 않는다 (호출 순서로 응답만 돌려준다).
 */
const txHash = `0x${'ab'.repeat(32)}`;
const config = (values: Record<string, string> = {}) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;

function build(values: Record<string, string> = {}) {
  const { database, db, txQuery: query } = createMockDb();
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new RewardsService(database, {} as never, audit as unknown as AuditService, config(values));
  return { service, db, query, audit };
}

describe('RewardsService input checks (before any transaction)', () => {
  it.each(['0xtx', '', 'ab'.repeat(31), `0x${'ab'.repeat(32)}0`])('markPaid rejects tx hash %p with 400 INVALID_TX_HASH', async (hash) => {
    const { service, db } = build();
    await expect(service.markPaid('payout', hash, 'admin')).rejects.toMatchObject({ status: 400, message: 'INVALID_TX_HASH' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it.each(['0xdeposit', 'ab'.repeat(31), `0x${'ab'.repeat(32)}0`, ''])('confirmDeposit rejects tx hash %p with 400 INVALID_TX_HASH', async (hash) => {
    const { service, db } = build();
    await expect(service.confirmDeposit('reward', hash, '1000000', 'admin')).rejects.toMatchObject({ message: 'INVALID_TX_HASH' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it.each(['0', '01', '1.0', '-5', ' 1', '1e3', '9'.repeat(79)])('confirmDeposit rejects deposited amount %p with 400 INVALID_TOKEN_AMOUNT', async (amount) => {
    const { service, db } = build();
    await expect(service.confirmDeposit('r', txHash, amount, 'admin')).rejects.toMatchObject({ message: 'INVALID_TOKEN_AMOUNT' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '1e6', '9'.repeat(79)])('requestPayout rejects token units %p with 400 INVALID_TOKEN_AMOUNT', async (amount) => {
    const { service, db } = build();
    await expect(service.requestPayout('reward', 'sub', amount, 'admin')).rejects.toThrow('INVALID_TOKEN_AMOUNT');
    expect(db.tx).not.toHaveBeenCalled();
  });
});

describe('RewardsService confirmDeposit unique violations', () => {
  it('maps a unique violation on uq_bounty_reward_deposit_tx to 409 TX_HASH_ALREADY_USED', async () => {
    const { service, db } = build();
    db.tx.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_bounty_reward_deposit_tx' }));
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toMatchObject({ status: 409, message: 'TX_HASH_ALREADY_USED' });
  });

  it.each([
    ['another unique index', 'uq_payout_idempotency'],
    ['no constraint name', undefined],
  ])('rethrows a unique violation from %s unchanged instead of calling it a reused hash', async (_what, constraint) => {
    const { service, db } = build();
    const boom = Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    db.tx.mockRejectedValueOnce(boom);
    await expect(service.confirmDeposit('reward', txHash, '1000000', 'admin')).rejects.toBe(boom);
  });
});

describe('RewardsService markApproved (two-person rule policy)', () => {
  /** the transaction answers: the payout row (requested_by), the APPROVED update, then anything else */
  function setup(options: { requestedBy?: string; allowSelf?: string } = {}) {
    const built = build(options.allowSelf === undefined ? {} : { PAYOUT_ALLOW_SELF_APPROVAL: options.allowSelf });
    built.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ requested_by: options.requestedBy ?? 'requester' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'payout', status: 'APPROVED' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const warn = jest.spyOn(built.service['logger'], 'warn').mockImplementation(() => undefined);
    return { ...built, warn };
  }
  const audited = (audit: { record: jest.Mock }) => audit.record.mock.calls.map(([actor, action]) => [actor, action]);

  it('a different admin approves: audited as PAYOUT_APPROVED, no self-approval warning', async () => {
    const { service, audit, warn } = setup();
    await expect(service.markApproved('payout', 'approver')).resolves.toEqual({ id: 'payout', status: 'APPROVED' });
    expect(audited(audit)).toEqual([['approver', 'PAYOUT_APPROVED']]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('the requesting admin is refused with 403 PAYOUT_SELF_APPROVAL and nothing is audited', async () => {
    const { service, audit } = setup({ requestedBy: 'admin' });
    await expect(service.markApproved('payout', 'admin')).rejects.toMatchObject({ status: 403, message: 'PAYOUT_SELF_APPROVAL' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(['false', '', '1', 'yes'])('PAYOUT_ALLOW_SELF_APPROVAL=%p keeps the rule', async (allowSelf) => {
    const { service } = setup({ requestedBy: 'admin', allowSelf });
    await expect(service.markApproved('payout', 'admin')).rejects.toMatchObject({ message: 'PAYOUT_SELF_APPROVAL' });
  });

  it.each(['true', ' TRUE '])('PAYOUT_ALLOW_SELF_APPROVAL=%p (solo operator) allows it with a warn and audits PAYOUT_SELF_APPROVED instead of PAYOUT_APPROVED', async (allowSelf) => {
    const { service, audit, warn } = setup({ requestedBy: 'admin', allowSelf });
    expect(warn).not.toHaveBeenCalled(); // the boot-time warn fired in the constructor, before the spy
    await expect(service.markApproved('payout', 'admin')).resolves.toEqual({ id: 'payout', status: 'APPROVED' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('approved by the admin who requested it'));
    expect(audited(audit)).toEqual([['admin', 'PAYOUT_SELF_APPROVED']]);
  });

  it('an unknown or non-approvable payout is 404 before the self-approval check', async () => {
    const { service, query, audit } = setup({ requestedBy: 'admin' });
    query.mockReset();
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(service.markApproved('payout', 'admin')).rejects.toThrow('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
    expect(audit.record).not.toHaveBeenCalled();
  });
});
