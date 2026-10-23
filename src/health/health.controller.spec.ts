import { ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns 200 {status: ok, db: up} when the database answers', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ '?column?': 1 }] }) };
    const controller = new HealthController({ query: withParamsCheck(db.query) } as unknown as DatabaseService);

    await expect(controller.check()).resolves.toEqual({ status: 'ok', db: 'up' });
    expect(db.query).toHaveBeenCalledWith('SELECT 1', undefined);
  });

  it('returns 503 with the same body shape when the database is down', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const controller = new HealthController({ query: withParamsCheck(db.query) } as unknown as DatabaseService);

    const error = await controller.check().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({ status: 'degraded', db: 'down' });
  });
});
