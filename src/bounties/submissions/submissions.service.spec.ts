import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { SubmissionsService } from './submissions.service';

describe('SubmissionsService submission modes', () => {
  const input = { submissionUrl: 'https://example.com/result', description: 'done' };

  function serviceWith(query: jest.Mock) {
    const db = {
      tx: jest.fn(async (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query })),
    };
    return new SubmissionsService(db as unknown as DatabaseService);
  }

  it('rejects a browser user on an agent-only bounty', async () => {
    const query = jest.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ application_required: false, submission_mode: 'AGENT', status: 'OPEN', submission_deadline: '2099-01-01' }],
    });

    await expect(serviceWith(query).submit('bounty', 'user', input))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores an authenticated agent and its revision', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ application_required: false, submission_mode: 'AGENT', status: 'OPEN', submission_deadline: '2099-01-01' }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'submission' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(serviceWith(query).submitAsAgent('bounty', 'agent', input)).resolves.toEqual({
      id: 'submission', revisionNo: 1, status: 'SUBMITTED',
    });
    expect(query.mock.calls[2][1].slice(0, 4)).toEqual(['bounty', null, null, 'agent']);
    expect(query.mock.calls[3][1].slice(-2)).toEqual([null, 'agent']);
  });
});

describe('SubmissionsService owner visibility of agent submissions', () => {
  it('lists submissions made by the user or by agents the user owns, keeping existing fields', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), tx: jest.fn() };
    await new SubmissionsService(db as unknown as DatabaseService).mySubmissions('user');
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual(['user']);
    expect(sql).toContain("json_build_object('id', ag.id, 'name', ag.name) END AS agent");
    expect(sql).toContain('LEFT JOIN agent ag ON ag.id = s.agent_id');
    expect(sql).toContain('WHERE s.submitter_user_id = $1');
    expect(sql).toContain('OR s.agent_id IN (SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL)');
    for (const kept of ['payment_status', 's.description', 'review.comment AS review_comment', 'b.category', 'ORDER BY s.submitted_at DESC']) {
      expect(sql).toContain(kept);
    }
  });
});

describe('SubmissionsService revisions after closing intake', () => {
  const input = { submissionUrl: 'https://example.com/revised', description: 'updated' };
  function setup(status: string, existingStatus?: string) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ application_required: false, submission_mode: 'DIRECT', status, submission_deadline: '2000-01-01' }] })
      .mockResolvedValueOnce({ rowCount: existingStatus ? 1 : 0, rows: existingStatus ? [{ id: 'sub', status: existingStatus, current_revision_no: 2 }] : [] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const db = { tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query }) };
    return { service: new SubmissionsService(db as never), query };
  }
  it.each(['SUBMISSION_CLOSED', 'IN_REVIEW'])('allows requested revisions in %s after the deadline', async (status) => {
    const { service, query } = setup(status, 'REVISION_REQUESTED');
    await expect(service.submit('bounty', 'user', input)).resolves.toEqual({ id: 'sub', revisionNo: 3, status: 'RESUBMITTED' });
    expect(query.mock.calls[2][0]).toContain('UPDATE bounty_submission');
    expect(query.mock.calls[3][0]).toContain('INSERT INTO submission_revision');
  });
  it.each([undefined, 'SUBMITTED', 'APPROVED'])('rejects closed-intake submission with status %s', async (status) => {
    const { service } = setup('IN_REVIEW', status);
    await expect(service.submit('bounty', 'user', input)).rejects.toThrow('BOUNTY_NOT_OPEN');
  });
  it('rejects revisions on completed bounties', async () => {
    await expect(setup('COMPLETED', 'REVISION_REQUESTED').service.submit('bounty', 'user', input)).rejects.toThrow('BOUNTY_NOT_OPEN');
  });
});
