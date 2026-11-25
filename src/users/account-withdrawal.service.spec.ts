import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { TERMINAL_PAYOUT_STATUSES } from '../rewards/payout-status';
import { createMockDb, SqlHandler } from '../test-support/mock-db';
import {
  AccountWithdrawalService,
  nicknameConfirmed,
  PENDING_REWARD_SQL,
  withdrawnIdentityPrefix,
} from './account-withdrawal.service';
import { WithdrawAccountDto } from './users.controller';

/**
 * 단위 스펙은 차단 검사의 순서와 입력 검사, 커밋 뒤 후처리(감사 호출, 캐시 비우기)만 본다. 실제로 어떤 행이 바뀌는지(유저 익명화, 세션 정리,
 * 지원·제출 철회, 차단 조건의 SQL, 경합)는 src/test-db/withdrawal.db-spec.ts와 cohorts.db-spec.ts가 실 DB 행으로 단언한다.
 * DB 대역은 엄격 모드라 등록하지 않은 문장(예: 차단된 탈퇴가 내보내면 안 되는 쓰기)이 나가면 `Unexpected SQL`로 실패한다.
 */
describe('AccountWithdrawalService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const none = { rowCount: 0, rows: [] };

  /** 차단 검사까지의 읽기 문장만 (쓰기 핸들러 없음: 쓰기가 나가면 strict 가 실패) */
  function readHandlers(options: { user?: { nickname: string } | null; openPayouts?: number; pendingRewards?: number } = {}): SqlHandler[] {
    return [
      { match: /FOR UPDATE$/, reply: () => {
        const user = options.user === undefined ? { nickname: 'Ryan' } : options.user;
        return user ? { rowCount: 1, rows: [user] } : none;
      } },
      { match: /FROM payout p JOIN bounty_submission s/, reply: () => ({ rowCount: 1, rows: [{ n: options.openPayouts ?? 0 }] }) },
      { match: /^SELECT count\(\*\)::int AS n FROM bounty_submission s JOIN bounty b/, reply: () => ({ rowCount: 1, rows: [{ n: options.pendingRewards ?? 0 }] }) },
    ];
  }

  /** 성공 경로: 읽기 + 각 모듈이 쓰는 문장 (전부 rowCount 1) */
  function writeHandlers(): SqlHandler[] {
    const ok = () => ({ rowCount: 1, rows: [] });
    return [
      { match: /^UPDATE "user" SET status = 'WITHDRAWN'/, reply: ok },
      { match: /^DELETE FROM user_link/, reply: ok },
      { match: /^DELETE FROM user_tag/, reply: ok },
      { match: /^SELECT avatar_media_id FROM "user"/, reply: () => ({ rowCount: 1, rows: [{ avatar_media_id: null }] }) },
      { match: /^UPDATE auth_session SET revoked_at/, reply: ok },
      { match: /^UPDATE bounty_submission SET status = 'WITHDRAWN'/, reply: ok },
      { match: /^UPDATE bounty_application SET status = 'WITHDRAWN'/, reply: ok },
      { match: /^UPDATE bounty_submission SET payout_address = NULL/, reply: ok },
      { match: /^UPDATE cohort_application/, reply: ok },
    ];
  }

  function setup(options: Parameters<typeof readHandlers>[0] & { writes?: boolean } = {}) {
    const mock = createMockDb({
      strict: true,
      handlers: [...readHandlers(options), ...(options.writes ? writeHandlers() : [])],
    });
    const record = jest.fn().mockResolvedValue(undefined);
    const forgetUserStatus = jest.fn();
    const service = new AccountWithdrawalService(
      mock.database,
      { record } as unknown as AuditService,
      { forgetUserStatus } as unknown as AuthService,
    );
    return { service, mock, record, forgetUserStatus };
  }

  it('withdraws in one transaction with the identity prefix and the bound statuses, audits the withdrawal with the same tx, and forgets the cached status afterwards', async () => {
    const { service, mock, record, forgetUserStatus } = setup({ writes: true });
    await expect(service.withdraw(userId, ' ryan ', 1_700_000_000_000)).resolves.toEqual({ ok: true });

    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.db.query).not.toHaveBeenCalled();
    expect(mock.txStatements(/^UPDATE "user" SET status = 'WITHDRAWN'/)[0].params).toEqual([userId, 'deleted:1700000000000:', 'withdrawn_']);
    expect(mock.txStatements(/^UPDATE bounty_submission SET status = 'WITHDRAWN'/)[0].params)
      .toEqual([userId, ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']]);
    expect(mock.txStatements(/^UPDATE bounty_submission SET payout_address = NULL/)[0].params).toEqual([userId]); // 지급 주소는 지우고 payout 스냅샷은 건드리지 않는다
    expect(mock.txStatements(/^UPDATE cohort_application/)[0].params).toEqual([userId, 'WITHDRAWN', 'SUBMITTED']); // 행은 지우지 않고 SUBMITTED만 철회
    expect(record.mock.calls).toEqual([
      [userId, 'USER_WITHDRAWN', 'user', userId, mock.txClient],
    ]);
    expect(forgetUserStatus).toHaveBeenCalledWith(userId);
  });

  it('rejects a mismatched confirmation nickname before any check or write', async () => {
    const { service, mock, record, forgetUserStatus } = setup();
    await expect(service.withdraw(userId, 'someone-else')).rejects.toMatchObject({ status: 400, message: 'CONFIRM_NICKNAME_MISMATCH' });
    expect(mock.txQuery).toHaveBeenCalledTimes(1); // only the user lock
    expect(record).not.toHaveBeenCalled();
    expect(forgetUserStatus).not.toHaveBeenCalled();
  });

  it('blocks with 409 WITHDRAWAL_BLOCKED_OPEN_PAYOUTS, binding the terminal payout statuses, and writes nothing', async () => {
    const { service, mock, record, forgetUserStatus } = setup({ openPayouts: 1 });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    expect(mock.txStatements(/FROM payout p/)[0].params).toEqual([userId, ['PAID', 'CANCELLED', 'FAILED']]);
    // 수령자는 제출(제출자)로 판단한다. 지갑 테이블은 더 보지 않는다(BE PR2)
    expect(mock.txStatements(/FROM payout p/)[0].sql).not.toMatch(/wallet/);
    expect(record).not.toHaveBeenCalled();
    expect(forgetUserStatus).not.toHaveBeenCalled();
  });

  it('blocks with 409 WITHDRAWAL_BLOCKED_PENDING_REWARDS, binding the in-progress bounty and payable reward statuses, and writes nothing', async () => {
    const { service, mock, record } = setup({ pendingRewards: 1 });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_PENDING_REWARDS' });
    expect(mock.txStatements(/FROM bounty_submission s JOIN bounty b/)[0].params)
      .toEqual([userId, ['OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW'], ['FUNDED', 'PARTIALLY_PAID', 'PAID']]);
    expect(mock.txStatements(/FROM bounty_submission s JOIN bounty b/)[0].sql).toBe(PENDING_REWARD_SQL.replace(/\s+/g, ' ').trim());
    expect(record).not.toHaveBeenCalled();
  });

  it('checks open payouts first (more specific), then pending rewards', async () => {
    const { service, mock } = setup({ openPayouts: 1, pendingRewards: 1 });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    expect(mock.txStatements(/FROM bounty_submission s JOIN bounty b/)).toHaveLength(0);
  });

  it('404 when the user is already withdrawn or suspended', async () => {
    const { service } = setup({ user: null });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
  });

  it('helpers', () => {
    expect(withdrawnIdentityPrefix(5)).toBe('deleted:5:');
    expect(nicknameConfirmed('Ryan', '  rYAN ')).toBe(true);
    expect(nicknameConfirmed('Ryan', 'Ryan2')).toBe(false);
    expect(nicknameConfirmed('한글닌자', '한글닌자'.normalize('NFD'))).toBe(true); // 같게 보이는 분해형도 확인으로 인정
    expect(TERMINAL_PAYOUT_STATUSES).toEqual(['PAID', 'CANCELLED', 'FAILED']);
  });
});

describe('WithdrawAccountDto', () => {
  const errors = (body: unknown) => validateSync(plainToInstance(WithdrawAccountDto, body)).map((e) => e.property);

  it('requires a non-blank string up to the nickname length', () => {
    expect(errors({ confirmNickname: 'ryan' })).toEqual([]);
    expect(errors({})).toEqual(['confirmNickname']);
    expect(errors({ confirmNickname: '   ' })).toEqual(['confirmNickname']);
    expect(errors({ confirmNickname: 42 })).toEqual(['confirmNickname']);
    expect(errors({ confirmNickname: 'x'.repeat(51) })).toEqual(['confirmNickname']);
  });
});
