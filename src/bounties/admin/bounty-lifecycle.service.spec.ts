import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createMockDb } from '../../test-support/mock-db';
import { Counts, countsHandler, FUTURE, PAST, transitionSetup } from '../../test-support/lifecycle-mock';
import { BountyLifecycleService } from './bounty-lifecycle.service';

/**
 * 단위 스펙은 카운트 -> 차단 사유 매핑, 마감 판정, 전이표 검사 순서, 취소 연쇄 호출만 본다. 카운트가 실제 행에서 어떻게 나오는지(어떤 상태를 세는가),
 * 전이표 49조합의 행 결과와 타임스탬프, 취소 연쇄가 바꾸는 행은 src/test-db/bounty-lifecycle.db-spec.ts가 실 DB로 단언한다.
 * DB 대역은 엄격 모드라 등록하지 않은 문장이 나가면 `Unexpected SQL`로 실패한다.
 */

/** One counts row per call - the blockers query is a single SELECT of six sub-counts */
function runnerWith(counts: Counts) {
  const mock = createMockDb({ strict: true, handlers: [countsHandler(counts)] });
  return { mock, runner: mock.txClient as never };
}

describe('BountyLifecycleService.blockers', () => {
  const lifecycle = new BountyLifecycleService();

  it('returns no blockers at all for a clean bounty with a future deadline, counting rows of this bounty only', async () => {
    const { runner, mock } = runnerWith({});
    await expect(lifecycle.blockers(runner, 'bounty-1', { status: 'OPEN', submission_deadline: FUTURE }))
      .resolves.toEqual({
        blockers: { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [], CANCELLED: [] },
        blockerDetails: { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [], CANCELLED: [] },
      });
    expect(mock.txQuery).toHaveBeenCalledTimes(1);
    // the unresolved-submission set is bound as $2 (the same set an account withdrawal withdraws, bounties/submission-status.ts)
    expect(mock.txQuery.mock.calls[0][1]).toEqual(['bounty-1', ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']]);
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
});

/**
 * BountyAdminService.transition over the whole table: the bounty row is read under FOR UPDATE, then (for allowed pairs only) the
 * blockers query, then the status UPDATE, then the audit row - all on the transaction client.
 */
describe('BountyAdminService.transition for every pair', () => {
  const ALL = ['DRAFT', 'FUNDING_PENDING', 'OPEN', 'SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'];
  const ALLOWED: Array<[string, string]> = [
    ['DRAFT', 'FUNDING_PENDING'], ['DRAFT', 'OPEN'], ['DRAFT', 'CANCELLED'],
    ['FUNDING_PENDING', 'OPEN'], ['FUNDING_PENDING', 'CANCELLED'],
    ['OPEN', 'SUBMISSION_CLOSED'], ['OPEN', 'CANCELLED'],
    ['SUBMISSION_CLOSED', 'IN_REVIEW'], ['SUBMISSION_CLOSED', 'OPEN'],
    ['IN_REVIEW', 'COMPLETED'], ['IN_REVIEW', 'OPEN'],
  ];
  const allowedKey = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
  const REFUSED = ALL.flatMap((from) => ALL.filter((to) => !allowedKey.has(`${from}->${to}`)).map((to) => [from, to] as const));

  it.each(ALLOWED)('%s -> %s: UPDATE status for this bounty, audit BOUNTY_<to>, nothing autocommits', async (from, to) => {
    const { service, mock } = transitionSetup(from);
    await expect(service.transition('b', to, 'admin')).resolves.toEqual({ id: 'b', status: to });
    expect(mock.txStatements(/^UPDATE bounty SET status = \$2/)[0].params).toEqual(['b', to]);
    expect(mock.txStatements(/^INSERT INTO audit_log/)[0].params).toEqual(['admin', `BOUNTY_${to}`, 'bounty', 'b']);
    expect(mock.db.tx).toHaveBeenCalledTimes(1);
    expect(mock.db.query).not.toHaveBeenCalled();
  });

  it.each(REFUSED)('%s -> %s is 400 INVALID_TRANSITION before the blockers query, nothing written', async (from, to) => {
    const { service, mock } = transitionSetup(from);
    const error = await service.transition('b', to, 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(`INVALID_TRANSITION:${from}->${to}`);
    expect(mock.txQuery).toHaveBeenCalledTimes(1); // only the row lock
  });

  it('a missing or deleted bounty is 404 BOUNTY_NOT_FOUND', async () => {
    const { service, mock } = transitionSetup(null);
    const error = await service.transition('b', 'OPEN', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe('BOUNTY_NOT_FOUND');
    expect(mock.txQuery).toHaveBeenCalledTimes(1);
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('cancelling from %s is not blocked by intake/review/funding counts (only owed winners block CANCELLED)', async (from) => {
    const { service } = transitionSetup(from, { pending: 2, unsubmitted: 1, unresolved: 1, unfunded: 1 }, PAST);
    await expect(service.transition('b', 'CANCELLED', 'admin')).resolves.toEqual({ id: 'b', status: 'CANCELLED' });
  });

  it('cancelling also closes the open work (pending applications rejected with the admin as reviewer) inside the same transaction', async () => {
    const { service, mock } = transitionSetup('OPEN', { pending: 2 });
    await service.transition('b', 'CANCELLED', 'admin');
    expect(mock.txStatements(/^UPDATE bounty_application/)[0].params).toEqual(['b', 'REJECTED', 'admin', 'PENDING']);
    expect(mock.db.query).not.toHaveBeenCalled();
  });

  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED'])('only cancelling touches applications (a transition to %s does not)', async (to) => {
    const from = { SUBMISSION_CLOSED: 'OPEN', IN_REVIEW: 'SUBMISSION_CLOSED', COMPLETED: 'IN_REVIEW' }[to]!;
    const { service, mock } = transitionSetup(from);
    await service.transition('b', to, 'admin');
    expect(mock.txStatements(/^UPDATE bounty_application/)).toHaveLength(0);
  });

  it.each([{ unpaid: 1 }, { unawarded: 1 }])('cancelling (after a reopen) is refused while an approved winner is still owed %j - 400 UNPAID_WINNERS sentence, row untouched', async (counts) => {
    const { service, mock } = transitionSetup('OPEN', counts);
    await expect(service.transition('b', 'CANCELLED', 'admin')).rejects.toMatchObject({
      response: { message: ['Record completed payments for all approved winners and finish every pending payout.'] },
    });
    expect(mock.txStatements(/^UPDATE bounty/)).toHaveLength(0);
  });

  it('the blockers of the TARGET status are the 400 body (the full list), and the row is not updated', async () => {
    const { service, mock } = transitionSetup('FUNDING_PENDING', { unfunded: 1 }, PAST);
    const error = await service.transition('b', 'OPEN', 'admin').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      statusCode: 400,
      message: ['Extend the submission deadline before opening this bounty.', 'Confirm all reward deposits before opening this bounty.'],
    });
    expect(mock.txStatements(/^UPDATE bounty/)).toHaveLength(0);
    expect(mock.txStatements(/audit_log/)).toHaveLength(0);
  });

  it('blockers of other target statuses do not block this one (SUBMISSION_CLOSED -> IN_REVIEW with pending and unresolved work)', async () => {
    await expect(transitionSetup('SUBMISSION_CLOSED', { pending: 1, unresolved: 1 }).service.transition('b', 'IN_REVIEW', 'admin'))
      .resolves.toEqual({ id: 'b', status: 'IN_REVIEW' });
  });
});

describe('BountyLifecycleService.closeOpenWork', () => {
  const lifecycle = new BountyLifecycleService();

  it('rejects PENDING applications, rejects unresolved submissions and records one review insert for exactly the closed ids, with no audit row', async () => {
    const { mock } = transitionSetup('OPEN', {}, FUTURE, ['s1', 's2']);
    await lifecycle.closeOpenWork(mock.txClient as never, 'b', 'admin');
    expect(mock.txStatements(/^UPDATE bounty_application/)[0].params).toEqual(['b', 'REJECTED', 'admin', 'PENDING']);
    expect(mock.txStatements(/^UPDATE bounty_submission/)[0].params).toEqual(['b', 'REJECTED', ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED']]);
    expect(mock.txStatements(/^INSERT INTO submission_review/).map(({ params }) => params)).toEqual([[['s1', 's2'], 'admin', 'REJECT', null]]);
    expect(mock.txQuery).toHaveBeenCalledTimes(3);
    expect(mock.txStatements(/audit_log/)).toHaveLength(0); // audit decision: BOUNTY_CANCELLED is the only record
  });

  it('writes no review row when no submission was left to close', async () => {
    const { mock } = transitionSetup('OPEN');
    await lifecycle.closeOpenWork(mock.txClient as never, 'b', 'admin');
    expect(mock.txStatements(/^INSERT INTO submission_review/)).toHaveLength(0);
  });

  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW', 'COMPLETED'])('transition to %s does not call closeOpenWork, CANCELLED does', async (to) => {
    const from = { SUBMISSION_CLOSED: 'OPEN', IN_REVIEW: 'SUBMISSION_CLOSED', COMPLETED: 'IN_REVIEW' }[to]!;
    const spy = jest.spyOn(BountyLifecycleService.prototype, 'closeOpenWork');
    try {
      await transitionSetup(from).service.transition('b', to, 'admin');
      expect(spy).not.toHaveBeenCalled();
      await transitionSetup('OPEN').service.transition('b', 'CANCELLED', 'admin');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
