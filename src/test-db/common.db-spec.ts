import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Pool } from 'pg';
import { AuditService } from '../audit/audit.service';
import { asClientError } from '../common/database/pg-errors';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { charLength, MaxChars } from '../common/validation/max-chars';
import { PG_INT_MAX } from '../common/validation/optional-not-null';
import { TOKEN_AMOUNT } from '../common/validation/token-amount';
import { describeDb } from './describe-db';
import { createDb, createUser, TEST_DB_URL_ENV, unique } from './harness';
import { sslOptions } from '../../scripts/migrate';

/** 카탈로그 밖의 임의 action/entity로 감사 테이블 동작만 보는 프로브 - 서비스 코드는 AuditAction 타입으로만 부른다 */
function rawRecord(audit: AuditService) {
  return audit.record.bind(audit) as (actorId: string | undefined, action: string, entityType: string, entityId: string, runner?: QueryRunner) => Promise<void>;
}

/** The validators and the DatabaseService plumbing checked against what Postgres actually does — not against our own assumptions */
describeDb('common plumbing on a real database', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onApplicationShutdown());

  const pgCode = (err: unknown) => (err as { code?: string }).code;

  describe('DatabaseService.tx', () => {
    beforeAll(async () => {
      await db.query('CREATE TABLE IF NOT EXISTS tx_probe (id TEXT PRIMARY KEY)');
    });

    it('commits the callback’s writes and returns its result', async () => {
      const id = unique();
      await expect(db.tx(async (client) => {
        await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
        return 'done';
      })).resolves.toBe('done');
      expect((await db.query('SELECT 1 FROM tx_probe WHERE id = $1', [id])).rowCount).toBe(1);
    });

    it('rolls every write back when the callback throws and rethrows the same error', async () => {
      const id = unique();
      const failure = new Error('CONFLICT');
      await expect(db.tx(async (client) => {
        await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
        throw failure;
      })).rejects.toBe(failure);
      expect((await db.query('SELECT 1 FROM tx_probe WHERE id = $1', [id])).rowCount).toBe(0);
    });

    it('rolls back on a Postgres error inside the callback (23505) and keeps the error code for the caller', async () => {
      const id = unique();
      await db.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
      const other = unique();
      const error = await db.tx(async (client) => {
        await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [other]);
        await client.query('INSERT INTO tx_probe (id) VALUES ($1)', [id]);
      }).catch((caught: unknown) => caught);
      expect(pgCode(error)).toBe('23505');
      expect((await db.query('SELECT 1 FROM tx_probe WHERE id = $1', [other])).rowCount).toBe(0);
    });

    it('returns clients to the pool after failures — 30 failing transactions on a 10-client pool do not exhaust it', async () => {
      for (let i = 0; i < 30; i++) {
        await db.tx(async (client) => { await client.query('SELECT 1/0'); }).catch(() => undefined);
      }
      const pool = (db as unknown as { pool: Pool }).pool;
      expect(pool.waitingCount).toBe(0);
      await expect(db.query<{ ok: number }>('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    });

    it('a connection killed mid-transaction surfaces the original error, discards the broken client and the pool keeps serving', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const caught = await db.tx(async (client) => {
          await client.query('SELECT pg_terminate_backend(pg_backend_pid())');
        }).catch((err: unknown) => err);
        expect(caught).toBeInstanceOf(Error);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('ROLLBACK failed, discarding client'));
        // the dropped socket's 'error' event is handled instead of crashing the process (it used to be an unhandled 'error' event)
        expect(error).toHaveBeenCalledWith(expect.stringContaining('database client error during transaction (client discarded)'));
        const pool = (db as unknown as { pool: Pool }).pool;
        for (let i = 0; i < 12; i++) await db.query('SELECT 1'); // every pooled client is healthy again
        expect(pool.totalCount).toBeLessThanOrEqual(10);
      } finally {
        error.mockRestore();
      }
    });
  });

  it('an idle pooled connection dropped by the server is logged, not an uncaught error event', async () => {
    const appName = unique('idle-');
    const url = new URL(process.env[TEST_DB_URL_ENV]!);
    url.searchParams.set('application_name', appName);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const victim = createDb({ DATABASE_URL: url.toString() });
    try {
      await victim.query('SELECT 1'); // leaves one idle client in the pool
      const killed = await db.query<{ n: number }>(
        `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE application_name = $1`, [appName]);
      expect(killed.rows[0].n).toBe(1);
      const deadline = Date.now() + 5000;
      while (!error.mock.calls.some(([line]) => String(line).includes('idle database client error')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(error).toHaveBeenCalledWith(expect.stringContaining('idle database client error (connection discarded)'));
      await expect(victim.query<{ ok: number }>('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    } finally {
      error.mockRestore();
      await victim.onApplicationShutdown();
    }
  });

  describe('MaxChars agrees with VARCHAR(n) and char_length()', () => {
    class Probe { @MaxChars(5) value!: string; }
    const passes = async (value: string) => (await validate(plainToInstance(Probe, { value }))).length === 0;

    beforeAll(async () => {
      await db.query('CREATE TABLE IF NOT EXISTS varchar_probe (v VARCHAR(5))');
    });

    it.each([
      'abcde', 'abcdef', '❤\ufe0f❤\ufe0f', '❤\ufe0f❤\ufe0f❤\ufe0f', '\ufe0f'.repeat(5), '\ufe0f'.repeat(6), '😀'.repeat(5), '😀'.repeat(6),
      '👨\u200d👩\u200d👧', '👨\u200d👩\u200d👧\u200d👦', 'e\u0301e\u0301e\u0301', '가나다라마', '가나다라마바', '\u200b'.repeat(5), '\u200b'.repeat(6),
    ])('%p: charLength = char_length(), and MaxChars(5) passes exactly when VARCHAR(5) stores it', async (value) => {
      const r = await db.query<{ n: number }>('SELECT char_length($1::text) AS n', [value]);
      expect(charLength(value)).toBe(r.rows[0].n);
      const stored = await db.query('INSERT INTO varchar_probe (v) VALUES ($1)', [value]).then(() => true, (err: unknown) => {
        expect(pgCode(err)).toBe('22001'); // string_data_right_truncation
        return false;
      });
      expect(await passes(value)).toBe(stored);
    });
  });

  it('PG_INT_MAX is the INTEGER limit: it casts, +1 is 22003', async () => {
    await expect(db.query('SELECT $1::int AS v', [PG_INT_MAX])).resolves.toMatchObject({ rows: [{ v: PG_INT_MAX }] });
    expect(pgCode(await db.query('SELECT $1::int', [PG_INT_MAX + 1]).catch((err: unknown) => err))).toBe('22003');
  });

  it('TOKEN_AMOUNT (30 digits) accepts only what DECIMAL(78,0) stores without rounding', async () => {
    for (const value of ['1', '9'.repeat(30), `1${'0'.repeat(29)}`]) {
      expect(TOKEN_AMOUNT.test(value)).toBe(true);
      const r = await db.query<{ v: string }>('SELECT $1::numeric(78,0)::text AS v', [value]);
      expect(r.rows[0].v).toBe(value);
    }
    const tooBig = `1${'0'.repeat(78)}`;
    expect(TOKEN_AMOUNT.test(tooBig)).toBe(false);
    expect(pgCode(await db.query('SELECT $1::numeric(78,0)', [tooBig]).catch((err: unknown) => err))).toBe('22003');
  });

  describe('asClientError on errors Postgres really raises', () => {
    it('NUL in a text value (22021) → 400 INVALID_CHARACTER', async () => {
      const err = await db.query('SELECT $1::text', ['a\u0000b']).catch((caught: unknown) => caught);
      expect(pgCode(err)).toBe('22021');
      expect(asClientError(err)).toEqual(new BadRequestException('INVALID_CHARACTER'));
    });

    it('a write pointing at a missing row (23503 "is not present") → 400 REFERENCE_NOT_FOUND', async () => {
      const err = await new AuditService(db).record('00000000-0000-4000-8000-000000000000', 'BOUNTY_UPDATED', 'bounty', '00000000-0000-4000-8000-000000000001')
        .catch((caught: unknown) => caught);
      expect(pgCode(err)).toBe('23503');
      expect(asClientError(err)).toEqual(new BadRequestException('REFERENCE_NOT_FOUND'));
    });

    it('deleting a row that is still referenced (23503 "still referenced") stays a server error', async () => {
      const userId = await createUser(db);
      await new AuditService(db).record(userId, 'USER_NICKNAME_CHANGED', 'user', userId);
      const err = await db.query('DELETE FROM "user" WHERE id = $1', [userId]).catch((caught: unknown) => caught);
      expect(pgCode(err)).toBe('23503');
      expect(asClientError(err)).toBe(err);
    });
  });

  describe('AuditService on a real database', () => {
    it('record() inside a rolled-back transaction leaves no audit row; outside it lands with a NULL actor for system jobs', async () => {
      const audit = new AuditService(db);
      const entityId = '11111111-1111-4111-8111-' + unique().slice(0, 12).padEnd(12, '0');
      await db.tx(async (client) => {
        await rawRecord(audit)(undefined, 'ROLLED_BACK', 'probe', entityId, client);
        throw new Error('abort');
      }).catch(() => undefined);
      await rawRecord(audit)(undefined, 'SYSTEM', 'probe', entityId);
      const rows = await db.query<{ action: string; actor_user_id: string | null }>(
        'SELECT action, actor_user_id FROM audit_log WHERE entity_id = $1', [entityId]);
      expect(rows.rows).toEqual([{ action: 'SYSTEM', actor_user_id: null }]);
    });

    it('list() filters by entity, pages 30 at a time newest first and counts the filtered total', async () => {
      const audit = new AuditService(db);
      const actor = await createUser(db);
      const entityType = unique('probe-');
      const entityId = '22222222-2222-4222-8222-' + unique().slice(0, 12).padEnd(12, '0');
      for (let i = 0; i < 31; i++) await rawRecord(audit)(actor, `A${String(i).padStart(2, '0')}`, entityType, entityId);
      await rawRecord(audit)(actor, 'OTHER', entityType, '33333333-3333-4333-8333-333333333333');

      const first = await audit.list({ page: 1, entityType, entityId });
      const second = await audit.list({ page: 2, entityType, entityId });
      expect([first.total, first.pageSize, first.items.length, second.items.length]).toEqual([31, 30, 30, 1]);
      const ids = [...first.items, ...second.items].map((row) => (row as { id: string }).id);
      expect(new Set(ids).size).toBe(31); // disjoint pages
      expect((await audit.list({ page: 1, entityType })).total).toBe(32);
      expect((await audit.list({ page: 1, entityType: `${entityType}' OR '1'='1` })).total).toBe(0); // bound, not interpolated
    });
  });

  it('sslOptions (scripts/migrate.js) mirrors database-ssl.ts', () => {
    expect(sslOptions({ PGSSLMODE: 'disable' })).toBeUndefined();
    expect(sslOptions({})).toEqual({ rejectUnauthorized: false });
    expect(sslOptions({ DATABASE_CA_CERT: '  ' })).toEqual({ rejectUnauthorized: false });
    const withCa = sslOptions({ DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----' }) as { ca: string[]; rejectUnauthorized: boolean };
    expect(withCa.rejectUnauthorized).toBe(true);
    expect(withCa.ca[withCa.ca.length - 1]).toBe('-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
    expect(withCa.ca.length).toBeGreaterThan(1); // public roots kept for the Supabase pooler
  });
});
