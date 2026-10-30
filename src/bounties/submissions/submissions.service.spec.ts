import { BadRequestException } from '@nestjs/common';
import { createMockDb } from '../../test-support/mock-db';
import { payoutStatusSql } from '../../rewards/payout-status';
import { SubmissionsService } from './submissions.service';

describe('SubmissionsService submission modes', () => {
  const input = { submissionUrl: 'https://example.com/result', description: 'done' };

  function serviceWith(query: jest.Mock) {
    const { database, db } = createMockDb({ txQuery: query });
    return { db, service: new SubmissionsService(database) };
  }

  it('rejects a browser user on an agent-only bounty', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ application_required: false, submission_mode: 'AGENT', status: 'OPEN', submission_deadline: '2099-01-01' }],
    });

    await expect(serviceWith(query).service.submit('bounty', 'user', input))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores an authenticated agent and its revision inside the transaction', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ application_required: false, submission_mode: 'AGENT', status: 'OPEN', submission_deadline: '2099-01-01' }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ done: true }] }) // the agent's owner finished onboarding
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'submission' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const { db, service } = serviceWith(query);

    await expect(service.submitAsAgent('bounty', 'agent', input)).resolves.toEqual({
      id: 'submission', revisionNo: 1, status: 'SUBMITTED',
    });
    expect(query.mock.calls[3][1].slice(0, 4)).toEqual(['bounty', null, null, 'agent']);
    expect(query.mock.calls[4][1].slice(-2)).toEqual([null, 'agent']);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('SubmissionsService owner visibility of agent submissions', () => {
  it('lists submissions made by the user or by agents the user owns, keeping existing fields', async () => {
    const query = jest.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    await new SubmissionsService(createMockDb({ query }).database).mySubmissions('user');
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual(['user']);
    expect(sql).toContain("json_build_object('id', ag.id, 'name', ag.name) END AS agent");
    expect(sql).toContain('LEFT JOIN agent ag ON ag.id = s.agent_id');
    expect(sql).toContain('WHERE s.submitter_user_id = $1');
    // `= ANY(ARRAY(subquery))` so the planner can BitmapOr idx_submission_submitter + idx_submission_agent_status (0015); `IN (subquery)` cannot
    expect(sql).toContain('OR s.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL))');
    expect(sql).not.toContain('agent_id IN (');
    expect(sql).toContain('JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL'); // soft-deleted bounties are gone, as on the public profile
    // same helper as the public profile payoutStatus, applied to APPROVED submissions only (anything else owes nothing → NONE)
    expect(sql).toContain(`CASE WHEN s.status = 'APPROVED' THEN ${payoutStatusSql('s', 'b')} ELSE 'NONE' END AS payment_status`);
    for (const kept of ['payment_status', 's.description', 'review.comment AS review_comment', 'b.category', 'b.status AS bounty_status', 'b.submission_deadline', 'AS has_review', "b.status = 'CANCELLED' AND review.decision = 'REJECT' AND review.comment IS NULL", 'ORDER BY s.submitted_at DESC']) {
      expect(sql).toContain(kept);
    }
  });
});

describe('SubmissionsService revisions after closing intake', () => {
  const input = { submissionUrl: 'https://example.com/revised', description: 'updated' };
  function setup(status: string, existingStatus?: string) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: false, submission_mode: 'DIRECT', status, submission_deadline: '2000-01-01' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ done: true }] }) // the person's onboarding check
      .mockResolvedValueOnce({ rowCount: existingStatus ? 1 : 0, rows: existingStatus ? [{ id: 'sub', status: existingStatus, current_revision_no: 2 }] : [] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const { database, db } = createMockDb({ txQuery: query });
    return { service: new SubmissionsService(database), query, db };
  }
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('allows requested revisions in %s after the deadline', async (status) => {
    const { service, query, db } = setup(status, 'REVISION_REQUESTED');
    await expect(service.submit('bounty', 'user', input)).resolves.toEqual({ id: 'sub', revisionNo: 3, status: 'RESUBMITTED' });
    expect(query.mock.calls[3][0]).toContain('UPDATE bounty_submission');
    expect(query.mock.calls[3][1]).toEqual(['sub', input.submissionUrl, input.description, null, null, 3]);
    expect(query.mock.calls[4][0]).toContain('INSERT INTO submission_revision');
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each([undefined, 'SUBMITTED', 'APPROVED'])('rejects closed-intake submission with status %s', async (status) => {
    const { service } = setup('IN_REVIEW', status);
    await expect(service.submit('bounty', 'user', input)).rejects.toThrow('BOUNTY_NOT_OPEN');
  });
  it('rejects revisions on completed bounties', async () => {
    await expect(setup('COMPLETED', 'REVISION_REQUESTED').service.submit('bounty', 'user', input)).rejects.toThrow('BOUNTY_NOT_OPEN');
  });
});

describe('SubmissionsService submit rules', () => {
  const FUTURE = '2999-01-01T00:00:00.000Z';
  const PAST = '2000-01-01T00:00:00.000Z';
  const input = { submissionUrl: 'https://example.com/w', description: 'work', repositoryUrl: 'https://github.com/x/y', commitSha: 'abc' };

  /**
   * Answers by statement shape. `existing` is the caller's current submission row (or none), `approvedApplication` the id of an
   * APPROVED application of this actor (or none) — the lookup itself must filter `status = 'APPROVED'`.
   */
  function setup(bounty: Record<string, unknown> | null, options: { existing?: { status: string; current_revision_no: number }; approvedApplication?: string; onboarded?: boolean } = {}) {
    const query = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('onboarding_completed_at')) return { rowCount: 1, rows: [{ done: options.onboarded ?? true }] };
      if (sql.includes('FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE')) {
        return bounty ? { rowCount: 1, rows: [{ application_required: false, submission_mode: 'DIRECT', status: 'OPEN', submission_deadline: FUTURE, ...bounty }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM bounty_application')) {
        const hit = sql.includes("status = 'APPROVED'") && options.approvedApplication;
        return hit ? { rowCount: 1, rows: [{ id: options.approvedApplication }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM bounty_submission')) {
        return options.existing ? { rowCount: 1, rows: [{ id: 'sub', ...options.existing }] } : { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO bounty_submission')) return { rowCount: 1, rows: [{ id: 'new-sub' }] };
      return { rowCount: 1, rows: [] };
    });
    const { database, db } = createMockDb({ txQuery: query });
    const wrote = () => query.mock.calls.some(([sql]) => /^\s*(UPDATE|INSERT)/.test(sql as string));
    const call = (fragment: string) => query.mock.calls.find(([sql]) => (sql as string).includes(fragment));
    return { service: new SubmissionsService(database), query, db, wrote, call };
  }

  it('404 BOUNTY_NOT_FOUND for an unknown or deleted bounty', async () => {
    const { service } = setup(null);
    await expect(service.submit('b', 'u', input)).rejects.toMatchObject({ status: 404, message: 'BOUNTY_NOT_FOUND' });
  });

  it.each(['DRAFT', 'FUNDING_PENDING', 'COMPLETED', 'CANCELLED'])('a %s bounty takes no submission or revision (400 BOUNTY_NOT_OPEN)', async (status) => {
    const { service, wrote } = setup({ status }, { existing: { status: 'REVISION_REQUESTED', current_revision_no: 1 } });
    await expect(service.submit('b', 'u', input)).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect(wrote()).toBe(false);
  });

  it('a person, or the owner of an agent, who has not finished onboarding is 409 PROFILE_REQUIRED and nothing is written', async () => {
    const blocked = setup({}, { onboarded: false });
    await expect(blocked.service.submit('b', 'u', input)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(blocked.call('onboarding_completed_at')![1]).toEqual(['u']);
    expect(blocked.wrote()).toBe(false);
    const agent = setup({ submission_mode: 'AGENT' }, { onboarded: false });
    await expect(agent.service.submitAsAgent('b', 'agent', input)).rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
    expect(agent.call('onboarding_completed_at')![1]).toEqual(['agent']);
    expect(agent.wrote()).toBe(false);
    const done = setup({ submission_mode: 'AGENT' });
    await expect(done.service.submitAsAgent('b', 'agent', input)).resolves.toEqual({ id: 'new-sub', revisionNo: 1, status: 'SUBMITTED' });
  });

  it('an agent on a DIRECT bounty is 400 DIRECT_SUBMISSION_REQUIRED', async () => {
    await expect(setup({ submission_mode: 'DIRECT' }).service.submitAsAgent('b', 'agent', input)).rejects.toMatchObject({ message: 'DIRECT_SUBMISSION_REQUIRED' });
  });

  it('an application bounty without an APPROVED application of this actor is 403 APPLICATION_NOT_APPROVED', async () => {
    const { service, call, wrote } = setup({ application_required: true });
    const error = await service.submit('b', 'u', input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 403, message: 'APPLICATION_NOT_APPROVED' });
    expect(call('FROM bounty_application')![1]).toEqual(['b', 'u']);
    expect(call('FROM bounty_application')![0]).toContain('applicant_user_id = $2');
    expect(wrote()).toBe(false);
  });

  it('links the APPROVED application to the new submission (agents are looked up by agent_id)', async () => {
    const { service, call } = setup({ application_required: true, submission_mode: 'AGENT' }, { approvedApplication: 'app-7' });
    await expect(service.submitAsAgent('b', 'agent', input)).resolves.toEqual({ id: 'new-sub', revisionNo: 1, status: 'SUBMITTED' });
    expect(call('FROM bounty_application')![0]).toContain('agent_id = $2');
    expect(call('INSERT INTO bounty_submission')![1]).toEqual(['b', 'app-7', null, 'agent', input.submissionUrl, input.description, input.repositoryUrl, input.commitSha]);
    expect(call('INSERT INTO submission_revision')![1]).toEqual(['new-sub', input.submissionUrl, input.description, input.repositoryUrl, input.commitSha, null, 'agent']);
  });

  it('a first submission past the deadline is 400 DEADLINE_PASSED', async () => {
    const { service, wrote } = setup({ submission_deadline: PAST });
    await expect(service.submit('b', 'u', input)).rejects.toMatchObject({ message: 'DEADLINE_PASSED' });
    expect(wrote()).toBe(false);
  });

  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('a first submission once intake closed (%s) is 400 BOUNTY_NOT_OPEN even before the deadline', async (status) => {
    const { service, wrote } = setup({ status });
    await expect(service.submit('b', 'u', input)).rejects.toMatchObject({ message: 'BOUNTY_NOT_OPEN' });
    expect(wrote()).toBe(false);
  });

  it.each(['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW'])('editing a %s submission after the deadline (bounty still OPEN) is 400 DEADLINE_PASSED', async (status) => {
    const { service, wrote } = setup({ submission_deadline: PAST }, { existing: { status, current_revision_no: 1 } });
    await expect(service.submit('b', 'u', input)).rejects.toMatchObject({ message: 'DEADLINE_PASSED' });
    expect(wrote()).toBe(false);
  });

  it('a requested revision may be delivered after the deadline while the bounty is still OPEN', async () => {
    const { service, call } = setup({ submission_deadline: PAST }, { existing: { status: 'REVISION_REQUESTED', current_revision_no: 2 } });
    await expect(service.submit('b', 'u', input)).resolves.toEqual({ id: 'sub', revisionNo: 3, status: 'RESUBMITTED' });
    expect(call('INSERT INTO submission_revision')![1]).toEqual(['sub', 3, input.submissionUrl, input.description, input.repositoryUrl, input.commitSha, 'u', null]);
  });

  it.each(['APPROVED', 'REJECTED'])('a %s submission is final: 409 SUBMISSION_FINALIZED before the deadline', async (status) => {
    const { service, wrote } = setup({}, { existing: { status, current_revision_no: 1 } });
    const error = await service.submit('b', 'u', input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, message: 'SUBMISSION_FINALIZED' });
    expect(wrote()).toBe(false);
  });

  it.each(['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW'])('editing a %s submission before the deadline bumps the revision and resets the status to RESUBMITTED', async (status) => {
    const { service, call } = setup({}, { existing: { status, current_revision_no: 5 } });
    await expect(service.submit('b', 'u', { submissionUrl: 'https://e.x/2', description: 'v6' })).resolves.toEqual({ id: 'sub', revisionNo: 6, status: 'RESUBMITTED' });
    const update = call('UPDATE bounty_submission')!;
    expect(update[0]).toContain("status = 'RESUBMITTED', current_revision_no = $6, last_resubmitted_at = now()");
    expect(update[1]).toEqual(['sub', 'https://e.x/2', 'v6', null, null, 6]); // optional fields cleared, not kept from the old revision
    expect(call('INSERT INTO submission_revision')![1]).toEqual(['sub', 6, 'https://e.x/2', 'v6', null, null, 'u', null]);
  });
});
