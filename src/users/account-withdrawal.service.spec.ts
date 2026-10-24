import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import {
  AccountWithdrawalService,
  nicknameConfirmed,
  TERMINAL_PAYOUT_STATUSES,
  withdrawnIdentityPrefix,
} from './account-withdrawal.service';
import { WithdrawAccountDto } from './users.controller';

describe('AccountWithdrawalService', () => {
  const userId = '11111111-1111-4111-8111-111111111111';

  function setup(options: { user?: { nickname: string } | null; openPayouts?: number; agents?: string[] } = {}) {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      if (sql.includes('FOR UPDATE')) {
        const user = options.user === undefined ? { nickname: 'Ryan' } : options.user;
        return user ? { rowCount: 1, rows: [user] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM payout p')) return { rowCount: 1, rows: [{ n: options.openPayouts ?? 0 }] };
      if (sql.includes('UPDATE agent SET')) {
        const rows = (options.agents ?? []).map((id) => ({ id }));
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    });
    const tx = { query };
    const db = { tx: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn(tx)) } as unknown as DatabaseService;
    const record = jest.fn().mockResolvedValue(undefined);
    const forgetUserStatus = jest.fn();
    const service = new AccountWithdrawalService(
      db,
      { record } as unknown as AuditService,
      { forgetUserStatus } as unknown as AuthService,
    );
    return { service, calls, record, forgetUserStatus, tx };
  }

  it('withdraws in one transaction: user row, sessions, wallets, agents + keys, pending applications, audit', async () => {
    const { service, calls, record, forgetUserStatus, tx } = setup({ agents: ['a1', 'a2'] });
    await expect(service.withdraw(userId, ' ryan ', 1_700_000_000_000)).resolves.toEqual({ ok: true });

    const sqls = calls.map(([sql]) => sql);
    const userUpdate = calls.find(([sql]) => sql.includes(`SET status = 'WITHDRAWN'`))!;
    expect(userUpdate[1]).toEqual([userId, 'deleted:1700000000000:', 'withdrawn_']);
    expect(userUpdate[0]).toContain('google_id = left($2 || google_id, 255)');
    expect(userUpdate[0]).toContain('email = left($2 || email, 320)');
    expect(userUpdate[0]).toContain('deleted_at = now()');
    expect(sqls.some((sql) => sql.includes('UPDATE auth_session SET revoked_at = now()'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('UPDATE wallet SET disconnected_at = now()'))).toBe(true);
    expect(sqls.some((sql) => sql.includes(`UPDATE agent_api_key SET status = 'REVOKED'`))).toBe(true);
    const submissionUpdate = calls.find(([sql]) => sql.includes(`UPDATE bounty_submission SET status = 'WITHDRAWN'`))!;
    expect(submissionUpdate[1]).toEqual([userId, ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']]);
    expect(submissionUpdate[0]).toContain('owner_user_id = $1');
    expect(sqls.some((sql) => sql.includes(`UPDATE bounty_application SET status = 'WITHDRAWN'`) && sql.includes(`status = 'PENDING'`))).toBe(true);
    expect(record.mock.calls).toEqual([
      [userId, 'AGENT_REVOKED', 'agent', 'a1', tx],
      [userId, 'AGENT_REVOKED', 'agent', 'a2', tx],
      [userId, 'USER_WITHDRAWN', 'user', userId, tx],
    ]);
    expect(forgetUserStatus).toHaveBeenCalledWith(userId);
  });

  it('rejects a mismatched confirmation nickname without writing anything', async () => {
    const { service, calls, record, forgetUserStatus } = setup();
    await expect(service.withdraw(userId, 'someone-else')).rejects.toMatchObject({ status: 400, message: 'CONFIRM_NICKNAME_MISMATCH' });
    expect(calls).toHaveLength(1);
    expect(record).not.toHaveBeenCalled();
    expect(forgetUserStatus).not.toHaveBeenCalled();
  });

  it('blocks with 409 WITHDRAWAL_BLOCKED_OPEN_PAYOUTS while a non-terminal payout exists', async () => {
    const { service, calls } = setup({ openPayouts: 1 });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ status: 409, message: 'WITHDRAWAL_BLOCKED_OPEN_PAYOUTS' });
    const check = calls.find(([sql]) => sql.includes('FROM payout p'))!;
    expect(check[1]).toEqual([userId, ['PAID', 'CANCELLED', 'FAILED']]);
    expect(calls.some(([sql]) => sql.includes(`SET status = 'WITHDRAWN'`))).toBe(false);
  });

  it('404 when the user is already withdrawn or suspended', async () => {
    const { service } = setup({ user: null });
    await expect(service.withdraw(userId, 'Ryan')).rejects.toMatchObject({ status: 404, message: 'USER_NOT_FOUND' });
  });

  it('helpers', () => {
    expect(withdrawnIdentityPrefix(5)).toBe('deleted:5:');
    expect(nicknameConfirmed('Ryan', '  rYAN ')).toBe(true);
    expect(nicknameConfirmed('Ryan', 'Ryan2')).toBe(false);
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
