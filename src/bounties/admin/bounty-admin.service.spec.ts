import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { BountyAdminService } from './bounty-admin.service';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardTokenResolver } from './reward-token.resolver';

describe('BountyAdminService update safeguards', () => {
  const bountyId = '11111111-1111-4111-8111-111111111111';
  const adminId = '22222222-2222-4222-8222-222222222222';
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();

  function setup(options: { exists?: boolean; approved?: number; status?: string; openFunds?: { open_rewards: number; open_payouts: number }; stored?: { submission_deadline: string; application_deadline: string | null } } = {}) {
    const stored = options.stored ?? { submission_deadline: future, application_deadline: null };
    // The dynamic UPDATE builder is the statement most likely to drift ($n vs values) — every tx statement is checked for it.
    const query = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rowCount: options.exists === false ? 0 : 1, rows: [{ id: bountyId, status: options.status ?? 'OPEN', ...stored }] };
      if (sql.includes('AS open_rewards')) return { rowCount: 1, rows: [options.openFunds ?? { open_rewards: 0, open_payouts: 0 }] };
      if (sql.includes("status = 'APPROVED'")) return { rowCount: 1, rows: [{ count: String(options.approved ?? 0) }] };
      if (sql.startsWith('UPDATE bounty')) return { rowCount: 1, rows: [{ id: bountyId, status: 'OPEN' }] };
      return { rowCount: 1, rows: [] };
    }));
    // db.query (autocommit) is a separate mock from the tx client — nothing in update() may run outside the transaction
    const db = { query: jest.fn(), tx: jest.fn(async (callback: (tx: { query: typeof query }) => Promise<unknown>) => callback({ query })) };
    const service = new BountyAdminService(
      db as unknown as DatabaseService,
      new AuditService(db as unknown as DatabaseService),
      {} as BountyLifecycleService,
      {} as RewardTokenResolver,
      { get: () => undefined } as unknown as ConfigService,
    );
    return { service, query, db };
  }

  it('updates inside one transaction with the bounty row locked and audits there', async () => {
    const { service, query, db } = setup({ approved: 1 });
    await expect(service.update(bountyId, { title: 'New', maxWinners: 2 }, adminId)).resolves.toEqual({ id: bountyId, status: 'OPEN' });
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls[0]).toContain('FOR UPDATE');
    expect(query.mock.calls[0][1]).toEqual([bountyId]);
    expect(sqls[1]).toContain(`SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`);
    expect(query.mock.calls[1][1]).toEqual([bountyId]);
    expect(sqls[2]).toContain('UPDATE bounty SET title = $2, max_winners = $3');
    expect(query.mock.calls[2][1]).toEqual([bountyId, 'New', 2]);
    expect(sqls[3]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[3][1]).toEqual([adminId, 'BOUNTY_UPDATED', 'bounty', bountyId]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('remove locks the bounty row, checks open funds, soft-deletes and audits BOUNTY_DELETED on the same transaction client (nothing autocommits)', async () => {
    const { service, query, db } = setup();
    await expect(service.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId, status: 'OPEN' });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('SELECT id FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE');
    const check = query.mock.calls[1][0] as string;
    expect(check).toContain("rw.status = 'REFUND_PENDING'");
    expect(check).toContain("rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')");
    expect(check).toContain('LEAST(rw.amount, rw.deposited_amount) >');
    expect(check).toContain("p.status NOT IN ('PAID', 'CANCELLED', 'FAILED')");
    expect(query.mock.calls[2][0]).toContain('UPDATE bounty SET deleted_at = now()');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[3][1]).toEqual([adminId, 'BOUNTY_DELETED', 'bounty', bountyId]);
  });

  it.each([
    ['a reward still holding funds', { open_rewards: 1, open_payouts: 0 }],
    ['a non-terminal payout', { open_rewards: 0, open_payouts: 1 }],
  ])('remove refuses with 409 BOUNTY_HAS_OPEN_FUNDS when there is %s — no UPDATE, no audit row', async (_label, openFunds) => {
    const { service, query } = setup({ openFunds });
    await expect(service.remove(bountyId, adminId)).rejects.toMatchObject({ status: 409, message: 'BOUNTY_HAS_OPEN_FUNDS' });
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('audit_log'))).toBe(false);
  });

  it('remove of a missing/deleted bounty is 404 before the funds check', async () => {
    const { service, query } = setup({ exists: false });
    await expect(service.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_NOT_FOUND' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['submissionDeadline', { submissionDeadline: past }],
    ['applicationDeadline', { applicationDeadline: past }],
  ])('rejects moving %s into the past without updating the row', async (_label, input) => {
    const { service, query } = setup();
    await expect(service.update(bountyId, input, adminId)).rejects.toMatchObject({ message: 'DEADLINE_IN_PAST' });
    expect(query.mock.calls[0][0]).toContain('status, submission_deadline, application_deadline FROM bounty');
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
  });

  it('accepts a past deadline that is unchanged from the stored one (FE re-sends it on every edit)', async () => {
    const storedPast = new Date(Date.now() - 3_600_000).toISOString();
    const { service, query } = setup({ stored: { submission_deadline: storedPast, application_deadline: storedPast } });
    // Same instant in a different textual form still counts as unchanged.
    const sameInstant = new Date(storedPast).toISOString().replace('.000Z', '+00:00');
    await expect(service.update(bountyId, { title: 'Edited', submissionDeadline: sameInstant, applicationDeadline: storedPast }, adminId))
      .resolves.toEqual({ id: bountyId, status: 'OPEN' });
    const update = query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty'))!;
    expect(update[1]).toEqual([bountyId, 'Edited', sameInstant, storedPast]);
  });

  it('treats a sub-minute difference as unchanged (datetime-local round trips drop seconds and milliseconds)', async () => {
    const truncated = new Date(Math.floor((Date.now() - 3_600_000) / 60_000) * 60_000).toISOString(); // what the FE sends back (:ss.SSS lost)
    const storedPast = new Date(new Date(truncated).getTime() + 42_500).toISOString(); // stored as :xx:42.500
    const { service, query } = setup({ stored: { submission_deadline: storedPast, application_deadline: storedPast } });
    await expect(service.update(bountyId, { title: 'Edited', submissionDeadline: truncated, applicationDeadline: truncated }, adminId))
      .resolves.toEqual({ id: bountyId, status: 'OPEN' });
    const update = query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty'))!;
    expect(update[1]).toEqual([bountyId, 'Edited', truncated, truncated]);

    // 60s or more is a real move, not rounding
    const movedByAMinute = new Date(new Date(storedPast).getTime() - 60_000).toISOString();
    await expect(setup({ stored: { submission_deadline: storedPast, application_deadline: null } }).service
      .update(bountyId, { submissionDeadline: movedByAMinute }, adminId)).rejects.toMatchObject({ message: 'DEADLINE_IN_PAST' });
  });

  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'])(
    'skips the past-deadline check once the bounty is %s (title/description edits must not be blocked by an old deadline)',
    async (status) => {
      const { service, query } = setup({ status, stored: { submission_deadline: future, application_deadline: null } });
      await expect(service.update(bountyId, { title: 'Edited', submissionDeadline: past, applicationDeadline: past }, adminId))
        .resolves.toEqual({ id: bountyId, status: 'OPEN' });
      const update = query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty'))!;
      expect(update[1]).toEqual([bountyId, 'Edited', past, past]);
    },
  );

  it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('still rejects a genuinely new past deadline while the bounty is %s', async (status) => {
    const { service, query } = setup({ status });
    await expect(service.update(bountyId, { submissionDeadline: past }, adminId)).rejects.toMatchObject({ message: 'DEADLINE_IN_PAST' });
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
  });

  it('still rejects a past deadline that differs from the stored past one', async () => {
    const storedPast = new Date(Date.now() - 3_600_000).toISOString();
    const { service } = setup({ stored: { submission_deadline: storedPast, application_deadline: null } });
    await expect(service.update(bountyId, { submissionDeadline: past }, adminId)).rejects.toMatchObject({ message: 'DEADLINE_IN_PAST' });
    await expect(setup({ stored: { submission_deadline: future, application_deadline: null } }).service
      .update(bountyId, { applicationDeadline: past }, adminId)).rejects.toMatchObject({ message: 'DEADLINE_IN_PAST' });
  });

  it('accepts future deadlines and clearing applicationDeadline with null', async () => {
    const { service, query } = setup();
    await service.update(bountyId, { submissionDeadline: future, applicationDeadline: null }, adminId);
    const update = query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty'))!;
    expect(update[1]).toEqual([bountyId, future, null]);
  });

  it('rejects maxWinners lower than the number of already approved submissions', async () => {
    const { service, query, db } = setup({ approved: 3 });
    await expect(service.update(bountyId, { maxWinners: 2 }, adminId)).rejects.toMatchObject({ message: 'MAX_WINNERS_BELOW_APPROVED' });
    expect(query.mock.calls.find(([sql]) => (sql as string).includes("status = 'APPROVED'"))![1]).toEqual([bountyId]);
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    await expect(setup({ approved: 2 }).service.update(bountyId, { maxWinners: 2 }, adminId)).resolves.toMatchObject({ id: bountyId });
  });

  it('skips the approved count when maxWinners is not part of the update', async () => {
    const { service, query } = setup();
    await service.update(bountyId, { title: 'x' }, adminId);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes("status = 'APPROVED'"))).toBe(false);
  });

  it('returns 404 for a deleted or unknown bounty', async () => {
    const { service } = setup({ exists: false });
    await expect(service.update(bountyId, { title: 'x' }, adminId)).rejects.toMatchObject({ message: 'BOUNTY_NOT_FOUND' });
  });
});
