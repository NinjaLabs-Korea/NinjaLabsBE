import { withParamsCheck } from '../../test-support/expect-params-match';
import { DatabaseService } from './database.service';
import { SchemaGuard, assertSchemaCurrent, missingMigrations } from './schema-guard';

jest.mock('../../../scripts/migrate', () => ({
  migrationFiles: jest.fn(() => ['0001_users.sql', '0013_oauth_login_codes.sql', '0014_security_hardening.sql']),
}));

describe('SchemaGuard', () => {
  const shipped = ['0001_users.sql', '0013_oauth_login_codes.sql', '0014_security_hardening.sql'];

  function setup(applied: string[] | Error) {
    const db = {
      query: jest.fn(withParamsCheck(async (sql: string) => {
        expect(sql).toBe('SELECT name FROM _migrations');
        if (applied instanceof Error) throw applied;
        return { rowCount: applied.length, rows: applied.map((name) => ({ name })) };
      })),
    };
    const guard = new SchemaGuard(db as unknown as DatabaseService);
    jest.spyOn(guard['logger'], 'log').mockImplementation(() => undefined);
    return { guard, db };
  }

  it('lists shipped migration files that _migrations does not contain, in file order', () => {
    expect(missingMigrations(shipped, ['0001_users.sql', '0013_oauth_login_codes.sql'])).toEqual(['0014_security_hardening.sql']);
    expect(missingMigrations(shipped, shipped)).toEqual([]);
    expect(missingMigrations(shipped, ['0014_security_hardening.sql'])).toEqual(['0001_users.sql', '0013_oauth_login_codes.sql']);
    expect(() => assertSchemaCurrent(shipped, shipped)).not.toThrow();
  });

  it('boots when every shipped migration is recorded in _migrations', async () => {
    const { guard, db } = setup(shipped);
    await expect(guard.onModuleInit()).resolves.toBeUndefined();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with a clear message naming the pending files (new code on the old schema)', async () => {
    const { guard } = setup(['0001_users.sql', '0013_oauth_login_codes.sql']);
    await expect(guard.onModuleInit()).rejects.toThrow('MIGRATIONS_PENDING: run npm run migrate (missing: 0014_security_hardening.sql)');
  });

  it('treats a database without the _migrations table as entirely unmigrated', async () => {
    const { guard } = setup(Object.assign(new Error('relation "_migrations" does not exist'), { code: '42P01' }));
    await expect(guard.onModuleInit()).rejects.toThrow(
      'MIGRATIONS_PENDING: run npm run migrate (missing: 0001_users.sql, 0013_oauth_login_codes.sql, 0014_security_hardening.sql)',
    );
  });

  it('propagates other database errors (connection refused is not "migrations pending")', async () => {
    const { guard } = setup(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(guard.onModuleInit()).rejects.toThrow('ECONNREFUSED');
  });
});
