import { BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { ApplicationsService } from './applications.service';

describe('ApplicationsService submission modes', () => {
  it('rejects a browser user on an agent-only bounty', async () => {
    const db = {
      query: jest.fn().mockResolvedValue({
        rowCount: 1,
        rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
      }),
    };
    const service = new ApplicationsService(db as unknown as DatabaseService);

    await expect(service.apply('bounty', 'user', 'hello')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.apply('bounty', 'user', 'hello')).rejects.toMatchObject({
      message: 'AGENT_SUBMISSION_REQUIRED',
    });
  });

  it('stores the authenticated agent as the application actor', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ application_required: true, submission_mode: 'AGENT', status: 'OPEN' }],
        })
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'application', status: 'PENDING' }] }),
    };
    const service = new ApplicationsService(db as unknown as DatabaseService);

    await service.applyAsAgent('bounty', 'agent', 'hello', 'https://example.com');

    expect(db.query.mock.calls[1][1]).toEqual([
      'bounty', null, 'agent', 'hello', 'https://example.com',
    ]);
  });
});
