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
