import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { owesUnpaidRewardSql, PAYABLE_REWARD_STATUSES, sqlStatusList } from '../../rewards/payout-status';
import { createMockDb } from '../../test-support/mock-db';
import { BountyAdminService } from './bounty-admin.service';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardTokenResolver } from './reward-token.resolver';

type Counts = Partial<Record<'pending' | 'unsubmitted' | 'unresolved' | 'unfunded' | 'unpaid' | 'unawarded', number>>;

const FUTURE = '2999-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const ZERO: Counts = { pending: 0, unsubmitted: 0, unresolved: 0, unfunded: 0, unpaid: 0, unawarded: 0 };

/** One counts row per call — the blockers query is a single SELECT of six sub-counts */
function runnerWith(counts: Counts) {
  const query = jest.fn(withParamsCheck(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [{ ...ZERO, ...counts }] })));
  return { query, runner: { query } as never };
}

describe('BountyLifecycleService.blockers', () => {
  const lifecycle = new BountyLifecycleService();

  it('returns no blockers at all for a clean bounty with a future deadline, counting rows of this bounty only', async () => {
    const { runner, query } = runnerWith({});
    await expect(lifecycle.blockers(runner, 'bounty-1', { status: 'OPEN', submission_deadline: FUTURE }))
      .resolves.toEqual({
        blockers: { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [], CANCELLED: [] },
        blockerDetails: { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [], CANCELLED: [] },
      });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(['bounty-1', expect.any(Array)]);
  });

  it('an expired submission deadline blocks (re)opening', async () => {
    const { runner } = runnerWith({});
    const { blockers } = await lifecycle.blockers(runner, 'b', { status: 'SUBMISSION_CLOSED', submission_deadline: PAST });
    expect(blockers.OPEN).toEqual(['Extend the submission deadline before opening this bounty.']);
    expect(blockers.SUBMISSION_CLOSED).toEqual([]);
  });

  it('a deadline exactly now counts as expired (<=), a missing deadline never does', async () => {
    jest.useFakeTimers({ now: new Date('2030-05-05T12:00:00.000Z') });
    try {
      const { runner } = runnerWith({});
      expect((await lifecycle.blockers(runner, 'b', { status: 'OPEN', submission_deadline: '2030-05-05T12:00:00.000Z' })).blockers.OPEN).toHaveLength(1);
      expect((await lifecycle.blockers(runner, 'b', { status: 'OPEN', submission_deadline: '2030-05-05T12:00:00.001Z' })).blockers.OPEN).toEqual([]);
      expect((await lifecycle.blockers(runner, 'b', { status: 'OPEN' })).blockers.OPEN).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an unconfirmed reward deposit blocks opening (and both reasons are listed together)', async () => {
    const { runner } = runnerWith({ unfunded: 1 });
    const { blockers } = await lifecycle.blockers(runner, 'b', { status: 'FUNDING_PENDING', submission_deadline: PAST });
    expect(blockers.OPEN).toEqual([
      'Extend the submission deadline before opening this bounty.',
      'Confirm all reward deposits before opening this bounty.',
    ]);
  });

  it('pending applications block both closing submissions and completing, with the count in the message', async () => {
    const { runner } = runnerWith({ pending: 3 });
    const { blockers } = await lifecycle.blockers(runner, 'b', { status: 'OPEN', submission_deadline: FUTURE });
    expect(blockers.SUBMISSION_CLOSED).toEqual(['Review 3 pending application(s) before closing submissions.']);
    expect(blockers.COMPLETED).toEqual(['Resolve 3 pending application(s).']);
    expect(blockers.OPEN).toEqual([]);
  });

  it('approved participants without a submission block closing only while the deadline is in the future', async () => {
    const before = await lifecycle.blockers(runnerWith({ unsubmitted: 2 }).runner, 'b', { status: 'OPEN', submission_deadline: FUTURE });
    expect(before.blockers.SUBMISSION_CLOSED).toEqual(['2 approved participant(s) have not submitted. Wait for their work or the submission deadline.']);
    expect(before.blockers.COMPLETED).toEqual([]); // not a completion blocker
    const after = await lifecycle.blockers(runnerWith({ unsubmitted: 2 }).runner, 'b', { status: 'OPEN', submission_deadline: PAST });
    expect(after.blockers.SUBMISSION_CLOSED).toEqual([]);
  });

  it('unresolved submissions (including requested revisions) block completion', async () => {
    const { blockers } = await lifecycle.blockers(runnerWith({ unresolved: 4 }).runner, 'b', { status: 'IN_REVIEW', submission_deadline: PAST });
    expect(blockers.COMPLETED).toEqual(['Finish 4 submission review(s), including requested revisions.']);
  });

  it.each([{ unpaid: 1 }, { unawarded: 1 }, { unpaid: 2, unawarded: 5 }])('payments outstanding %j block completion with one message', async (counts) => {
    const { blockers } = await lifecycle.blockers(runnerWith(counts).runner, 'b', { status: 'IN_REVIEW', submission_deadline: PAST });
    expect(blockers.COMPLETED).toEqual(['Record completed payments for all approved winners and finish every pending payout.']);
  });

  it('nothing ever blocks IN_REVIEW (closing review intake is always allowed from SUBMISSION_CLOSED)', async () => {
    const { blockers } = await lifecycle.blockers(runnerWith({ pending: 1, unsubmitted: 1, unresolved: 1, unfunded: 1, unpaid: 1, unawarded: 1 }).runner,
      'b', { status: 'SUBMISSION_CLOSED', submission_deadline: FUTURE });
    expect(blockers.IN_REVIEW).toEqual([]);
  });

  it('the counting SQL defines each blocker by the statuses the rules talk about', async () => {
    const { runner, query } = runnerWith({});
    await lifecycle.blockers(runner, 'b', { status: 'OPEN' });
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("bounty_application WHERE bounty_id = $1 AND status = 'PENDING') AS pending");
    // unresolved = submission-status.ts의 미결 집합을 $2로 바인딩 (탈퇴 시 철회 대상과 같은 집합)
    expect(sql).toContain('status = ANY($2::text[])) AS unresolved');
    expect(query.mock.calls[0][1]).toEqual(['b', ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']]);
    // 보상/payout 규칙은 rewards/payout-status.ts가 단일 출처 — 여기 문자열이 아니라 그 상수/헬퍼로 기대값을 만든다
    expect(sql).toContain(`status NOT IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})) AS unfunded`);
    // unpaid = 진행 중 payout만 (CANCELLED/FAILED/PAID는 아님 — 수동 취소한 payout이 COMPLETED를 영구히 막지 않게)
    expect(sql).toContain("p.status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING')) AS unpaid");
    // unawarded = 응답의 payoutStatus가 PENDING/PARTIALLY_PAID인 승인 제출 (보상 소진·수상 취소는 막지 않는다)
    expect(sql).toContain(`s.status = 'APPROVED' AND ${owesUnpaidRewardSql('s', 'b')}) AS unawarded`);
  });
});

/**
 * BountyAdminService.transition over the whole table: the bounty row is read under FOR UPDATE, then (for allowed pairs only) the
 * blockers query, then the status UPDATE with the first-entry stamp, then the audit row — all on the transaction client.
 */
describe('BountyAdminService.transition for every pair', () => {
  const ALL = ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'];
  const ALLOWED: Array<[string, string, string | undefined]> = [
    ['DRAFT', 'FUNDING_PENDING', undefined], ['DRAFT', 'OPEN', 'opened_at'], ['DRAFT', 'CANCELLED', undefined],
    ['FUNDING_PENDING', 'OPEN', 'opened_at'], ['FUNDING_PENDING', 'CANCELLED', undefined],
    ['OPEN', 'SUBMISSION_CLOSED', undefined], ['OPEN', 'CANCELLED', undefined],
    ['SUBMISSION_CLOSED', 'IN_REVIEW', 'review_started_at'], ['SUBMISSION_CLOSED', 'OPEN', 'opened_at'],
    ['IN_REVIEW', 'COMPLETED', 'completed_at'], ['IN_REVIEW', 'OPEN', 'opened_at'],
  ];
  const allowedKey = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
  const REFUSED = ALL.flatMap((from) => ALL.filter((to) => !allowedKey.has(`${from}->${to}`)).map((to) => [from, to] as const));

  function setup(status: string | null, counts: Counts = {}, deadline = FUTURE) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE')) {
        return status === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ status, submission_deadline: deadline }] };
      }
      if (sql.includes('AS pending')) return { rowCount: 1, rows: [{ ...ZERO, ...counts }] };
      return { rowCount: 1, rows: [] };
    });
    const dbQuery = jest.fn();
    const { database } = createMockDb({ query: dbQuery, txQuery: query });
    const service = new BountyAdminService(database, new AuditService(database), new BountyLifecycleService(), {} as RewardTokenResolver);
    return { service, query, dbQuery };
  }

  it.each(ALLOWED)('%s -> %s: UPDATE status (stamp %s), audit BOUNTY_<to>, nothing autocommits', async (from, to, stamp) => {
    const { service, query, dbQuery } = setup(from);
    await expect(service.transition('b', to, 'admin')).resolves.toEqual({ id: 'b', status: to });
    const update = query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty SET status'))!;
    expect(update[1]).toEqual(['b', to]);
    expect(update[0]).toBe(stamp
      ? `UPDATE bounty SET status = $2, ${stamp} = COALESCE(${stamp}, now()) WHERE id = $1`
      : 'UPDATE bounty SET status = $2 WHERE id = $1');
    expect(query.mock.calls.at(-1)![1]).toEqual(['admin', `BOUNTY_${to}`, 'bounty', 'b']);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it.each(REFUSED)('%s -> %s is 400 INVALID_TRANSITION before the blockers query, nothing written', async (from, to) => {
    const { service, query } = setup(from);
    const error = await service.transition('b', to, 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(`INVALID_TRANSITION:${from}->${to}`);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('a missing or deleted bounty is 404 BOUNTY_NOT_FOUND', async () => {
    const { service, query } = setup(null);
    const error = await service.transition('b', 'OPEN', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe('BOUNTY_NOT_FOUND');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('cancelling from %s is not blocked by intake/review/funding counts (only owed winners block CANCELLED)', async (from) => {
    const { service } = setup(from, { pending: 2, unsubmitted: 1, unresolved: 1, unfunded: 1 }, PAST);
    await expect(service.transition('b', 'CANCELLED', 'admin')).resolves.toEqual({ id: 'b', status: 'CANCELLED' });
  });

  it.each([{ unpaid: 1 }, { unawarded: 1 }])('cancelling (after a reopen) is refused while an approved winner is still owed %j — 400 UNPAID_WINNERS sentence, row untouched', async (counts) => {
    const { service, query } = setup('OPEN', counts);
    await expect(service.transition('b', 'CANCELLED', 'admin')).rejects.toMatchObject({
      response: { message: ['Record completed payments for all approved winners and finish every pending payout.'] },
    });
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty SET status'))).toBe(false);
  });

  it('the blockers of the TARGET status are the 400 body (the full list), and the row is not updated', async () => {
    const { service, query } = setup('FUNDING_PENDING', { unfunded: 1 }, PAST);
    const error = await service.transition('b', 'OPEN', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: ['Extend the submission deadline before opening this bounty.', 'Confirm all reward deposits before opening this bounty.'],
    });
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => (sql as string).includes('audit_log'))).toBe(false);
  });

  it('blockers of other target statuses do not block this one (SUBMISSION_CLOSED -> IN_REVIEW with pending and unresolved work)', async () => {
    await expect(setup('SUBMISSION_CLOSED', { pending: 1, unresolved: 1 }).service.transition('b', 'IN_REVIEW', 'admin'))
      .resolves.toEqual({ id: 'b', status: 'IN_REVIEW' });
  });
});
