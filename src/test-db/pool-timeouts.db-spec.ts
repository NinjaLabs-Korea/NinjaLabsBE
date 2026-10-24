import { ArgumentsHost, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DatabaseService } from '../common/database/database.service';
import { HttpExceptionFilter } from '../common/http/http-exception.filter';
import { PgThrottlerStorage } from '../common/throttler/pg-throttler-storage';
import { describeDb } from './describe-db';
import { createDb, unique } from './harness';

/**
 * pool-timeouts.ts 의 타임아웃이 실 Postgres 에서 실제로 걸리는지 — statement_timeout(서버 취소 57014), 풀 고갈 시
 * connectionTimeoutMillis(→ 503 DATABASE_UNAVAILABLE), 그리고 그 상태에서 PgThrottlerStorage 가 fail-open 하는지.
 */
describeDb('database pool timeouts (real Postgres)', () => {
  const opened: DatabaseService[] = [];
  const open = (overrides: Record<string, string>) => {
    const db = createDb(overrides);
    opened.push(db);
    return db;
  };
  afterAll(async () => {
    await Promise.all(opened.map((db) => db.onApplicationShutdown()));
  });

  it('sets statement_timeout on every pooled session, and pg_sleep beyond it is cancelled by the server (57014)', async () => {
    const db = open({ DB_STATEMENT_TIMEOUT_MS: '300' });
    const shown = await db.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(shown.rows[0].statement_timeout).toBe('300ms');

    const startedAt = Date.now();
    await expect(db.query('SELECT pg_sleep(3)')).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - startedAt).toBeLessThan(2500);
    // the same timeout applies inside tx() (pooled client), and the pool stays usable afterwards
    await expect(db.tx((client) => client.query('SELECT pg_sleep(3)'))).rejects.toMatchObject({ code: '57014' });
    await expect(db.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });

  it('defaults to a 15 s statement_timeout when the env is unset', async () => {
    const db = open({});
    const shown = await db.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(shown.rows[0].statement_timeout).toBe('15s');
  });

  it('an exhausted pool rejects after connectionTimeoutMillis; the filter answers 503 and the throttler storage fails open', async () => {
    const db = open({ DB_CONNECTION_TIMEOUT_MS: '300' });
    // hold all 10 pooled connections
    const holders = Array.from({ length: 10 }, () => db.query('SELECT pg_sleep(1.5)'));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const startedAt = Date.now();
    const timedOut = await db.query('SELECT 1').then(() => undefined, (err: unknown) => err);
    expect(Date.now() - startedAt).toBeLessThan(1200);
    expect(timedOut).toBeInstanceOf(Error);
    expect((timedOut as Error).message).toBe('timeout exceeded when trying to connect');

    const base = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const host = { switchToHttp: () => ({ getRequest: () => ({ method: 'GET', path: '/bounties' }) }) } as unknown as ArgumentsHost;
      new HttpExceptionFilter().catch(timedOut, host);
      const [sent] = base.mock.calls[0] as unknown as [HttpException];
      expect(sent).toBeInstanceOf(ServiceUnavailableException);
      expect(sent.getResponse()).toMatchObject({ statusCode: 503, message: 'DATABASE_UNAVAILABLE' });

      const storage = new PgThrottlerStorage(db);
      jest.spyOn(storage['logger'], 'error').mockImplementation(() => undefined);
      await expect(storage.increment(unique('ip-'), 60_000, 1, 60_000, 'default'))
        .resolves.toEqual({ totalHits: 0, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
    } finally {
      jest.restoreAllMocks();
    }

    await Promise.all(holders);
    await expect(db.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
  });
});
