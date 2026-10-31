import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { poolTimeoutOptions } from '../../../scripts/migrate';
import { DatabaseService } from './database.service';
import {
  databaseTimeoutOptions,
  DEFAULT_DB_CONNECTION_TIMEOUT_MS,
  DEFAULT_DB_IDLE_TIMEOUT_MS,
  DEFAULT_DB_STATEMENT_TIMEOUT_MS,
  QUERY_TIMEOUT_MARGIN_MS,
} from './pool-timeouts';

describe('databaseTimeoutOptions', () => {
  it('defaults: 5 s connect/pool wait, 30 s idle, 15 s statement, query_timeout slightly above the statement timeout', () => {
    expect(databaseTimeoutOptions({})).toEqual({
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      query_timeout: 15000 + QUERY_TIMEOUT_MARGIN_MS,
    });
  });

  it('reads DB_CONNECTION_TIMEOUT_MS and DB_STATEMENT_TIMEOUT_MS; query_timeout follows the statement timeout', () => {
    expect(databaseTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: ' 2500 ', DB_STATEMENT_TIMEOUT_MS: '8000' })).toEqual({
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: DEFAULT_DB_IDLE_TIMEOUT_MS,
      statement_timeout: 8000,
      query_timeout: 8000 + QUERY_TIMEOUT_MARGIN_MS,
    });
  });

  it.each(['', '0', '-1', 'abc', '1.5', '5s', '1e4', '99999999999999999999'])(
    'falls back to the defaults for an invalid value %p (a typo never disables the timeout)',
    (raw) => {
      const options = databaseTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: raw, DB_STATEMENT_TIMEOUT_MS: raw });
      expect(options.connectionTimeoutMillis).toBe(DEFAULT_DB_CONNECTION_TIMEOUT_MS);
      expect(options.statement_timeout).toBe(DEFAULT_DB_STATEMENT_TIMEOUT_MS);
    },
  );
});

describe('DatabaseService pool timeouts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes the timeouts from ConfigService to its pg Pool', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const values: Record<string, string> = {
      DATABASE_URL: 'postgresql://u@127.0.0.1:1/x', PGSSLMODE: 'disable', DB_CONNECTION_TIMEOUT_MS: '1234', DB_STATEMENT_TIMEOUT_MS: '4321',
    };
    const db = new DatabaseService({ get: (key: string) => values[key] } as unknown as ConfigService);
    const options = (db as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
    expect(options).toMatchObject({ connectionTimeoutMillis: 1234, idleTimeoutMillis: 30000, statement_timeout: 4321, query_timeout: 4321 + QUERY_TIMEOUT_MARGIN_MS });
    await db.onApplicationShutdown();
  });
});

describe('scripts/migrate.js poolTimeoutOptions', () => {
  it('uses the same DB_CONNECTION_TIMEOUT_MS rule (default 5000) and never sets a statement or query timeout', () => {
    expect(poolTimeoutOptions({})).toEqual({ connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    expect(poolTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: '7000', DB_STATEMENT_TIMEOUT_MS: '100' })).toEqual({ connectionTimeoutMillis: 7000, idleTimeoutMillis: 30000 });
    for (const raw of ['0', '-5', 'x', '']) expect(poolTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: raw }).connectionTimeoutMillis).toBe(5000);
    expect(Object.keys(poolTimeoutOptions({}))).not.toEqual(expect.arrayContaining(['statement_timeout']));
    expect(Object.keys(poolTimeoutOptions({}))).not.toEqual(expect.arrayContaining(['query_timeout']));
  });
});

describe('pool-timeouts.ts ↔ scripts/migrate.js parity', () => {
  // migrate.js cannot import the TS module, so it carries a copy of the rule - this keeps the two from drifting apart
  it.each([undefined, '', ' ', '0', '-5', 'x', '1e3', '0x10', '5000.5', ' 7 ', '007', '9'.repeat(30), '2500', '1'])(
    'DB_CONNECTION_TIMEOUT_MS=%j resolves to the same connectionTimeoutMillis in the app pool and in migrate/ops scripts',
    (raw) => {
      expect(poolTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: raw }).connectionTimeoutMillis).toBe(
        databaseTimeoutOptions({ DB_CONNECTION_TIMEOUT_MS: raw }).connectionTimeoutMillis,
      );
    },
  );
});

