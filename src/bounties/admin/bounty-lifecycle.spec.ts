import { countsHandler, transitionSetup } from '../../test-support/lifecycle-mock';
import { createMockDb } from '../../test-support/mock-db';
import { BountyLifecycleService } from './bounty-lifecycle.service';

/**
 * 생명주기 순서 규칙(카운트 + 상태 + 마감 -> 허용/차단)을 단위로 본다. 같은 규칙을 실제 행에서 세는 것, 지원서 심사와 지원 마감 규칙, 승인 상한은
 * src/test-db/bounty-lifecycle.db-spec.ts, submission-review.db-spec.ts, bounty-rules.db-spec.ts(경합 포함)가 실 DB 행으로 단언한다.
 */
const statusUpdate = (mock: ReturnType<typeof transitionSetup>['mock']) => mock.txStatements(/^UPDATE bounty SET status = \$2/)[0];

describe('Bounty lifecycle ordering', () => {
  it.each([{ pending: 1 }, { unsubmitted: 1 }])('blocks closing with unfinished intake %j', async (counts) => {
    const { service, mock } = transitionSetup('OPEN', counts);
    await expect(service.transition('b', 'SUBMISSION_CLOSED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
    expect(mock.txStatements(/^UPDATE bounty/)).toHaveLength(0);
    // the blockers query counts the rows of THIS bounty
    expect(mock.txStatements(/AS unawarded$/)[0].params).toEqual(['b', expect.any(Array)]);
    expect(mock.db.query).not.toHaveBeenCalled();
  });
  it('allows closing after the submission deadline when approved participants never submitted', async () => {
    const { service, mock } = transitionSetup('OPEN', { unsubmitted: 1 }, '2020-01-01');
    await expect(service.transition('b', 'SUBMISSION_CLOSED', 'admin')).resolves.toMatchObject({ status: 'SUBMISSION_CLOSED' });
    expect(statusUpdate(mock).params).toEqual(['b', 'SUBMISSION_CLOSED']);
    expect(mock.txStatements(/^INSERT INTO audit_log/)[0].params).toEqual(['admin', 'BOUNTY_SUBMISSION_CLOSED', 'bounty', 'b']);
    expect(mock.db.query).not.toHaveBeenCalled();
  });
  it.each([{ unresolved: 1 }, { pending: 1 }, { unpaid: 1 }, { unawarded: 1 }])('blocks completion with outstanding work %j', async (counts) => {
    const { service, mock } = transitionSetup('IN_REVIEW', counts);
    await expect(service.transition('b', 'COMPLETED', 'admin')).rejects.toMatchObject({ response: { message: [expect.any(String)] } });
    expect(mock.txStatements(/^UPDATE bounty/)).toHaveLength(0);
  });
  it.each([{ unpaid: 1 }, { unawarded: 1 }])('blocks cancelling while an approved winner is still owed %j (same UNPAID_WINNERS sentence as COMPLETED)', async (counts) => {
    const { service, mock } = transitionSetup('OPEN', counts);
    await expect(service.transition('b', 'CANCELLED', 'admin')).rejects.toMatchObject({
      response: { message: ['Record completed payments for all approved winners and finish every pending payout.'] },
    });
    expect(mock.txStatements(/^UPDATE bounty/)).toHaveLength(0);
  });
  it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('still cancels %s when no winner is owed (other blockers do not apply to CANCELLED)', async (status) => {
    const { service, mock } = transitionSetup(status, { pending: 1, unsubmitted: 1, unresolved: 1, unfunded: 1 });
    await expect(service.transition('b', 'CANCELLED', 'admin')).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(statusUpdate(mock).params).toEqual(['b', 'CANCELLED']);
  });
  it('allows completion after all reviews and payments are settled', async () => {
    const { service, mock } = transitionSetup('IN_REVIEW');
    await expect(service.transition('b', 'COMPLETED', 'admin')).resolves.toMatchObject({ status: 'COMPLETED' });
    expect(statusUpdate(mock).params).toEqual(['b', 'COMPLETED']);
    expect(mock.db.query).not.toHaveBeenCalled();
  });
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('reopens %s with a future deadline, refuses it with an expired one', async (status) => {
    const reopened = transitionSetup(status);
    await expect(reopened.service.transition('b', 'OPEN', 'admin')).resolves.toMatchObject({ status: 'OPEN' });
    expect(statusUpdate(reopened.mock).params).toEqual(['b', 'OPEN']);
    const expired = transitionSetup(status, {}, '2020-01-01');
    await expect(expired.service.transition('b', 'OPEN', 'admin')).rejects.toMatchObject({ response: { message: [expect.stringContaining('deadline')] } });
    expect(expired.mock.txStatements(/^UPDATE bounty SET status/)).toHaveLength(0);
  });
});

describe('Lifecycle blocker codes (operations UI)', () => {
  const blockersFor = async (counts: Record<string, number>, expired = false) => {
    const mock = createMockDb({ strict: true, handlers: [countsHandler(counts)] });
    return new BountyLifecycleService().blockers(mock.txClient as never, 'b', { status: 'OPEN', submission_deadline: expired ? '2020-01-01' : '2099-01-01' });
  };

  it('returns the same list as stable codes with counts next to the English sentences', async () => {
    const result = await blockersFor({ pending: 2, unsubmitted: 1, unresolved: 3, unfunded: 1, unpaid: 1 }, false);
    expect(result.blockerDetails).toEqual({
      OPEN: [{ code: 'REWARDS_UNFUNDED', count: 1 }],
      SUBMISSION_CLOSED: [{ code: 'PENDING_APPLICATIONS', count: 2 }, { code: 'UNSUBMITTED_PARTICIPANTS', count: 1 }],
      IN_REVIEW: [],
      COMPLETED: [{ code: 'PENDING_APPLICATIONS', count: 2 }, { code: 'UNRESOLVED_SUBMISSIONS', count: 3 }, { code: 'UNPAID_WINNERS' }],
      CANCELLED: [{ code: 'UNPAID_WINNERS' }],
    });
    expect(result.blockers.SUBMISSION_CLOSED).toEqual([
      'Review 2 pending application(s) before closing submissions.',
      '1 approved participant(s) have not submitted. Wait for their work or the submission deadline.',
    ]);
    for (const to of Object.keys(result.blockers)) expect(result.blockerDetails[to]).toHaveLength(result.blockers[to].length);
  });

  it('an expired deadline blocks re-opening (DEADLINE_PASSED) and no longer waits for unsubmitted participants', async () => {
    const result = await blockersFor({ unsubmitted: 1 }, true);
    expect(result.blockerDetails.OPEN).toEqual([{ code: 'DEADLINE_PASSED' }]);
    expect(result.blockerDetails.SUBMISSION_CLOSED).toEqual([]);
  });
});
