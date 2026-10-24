import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { applyMigrations, findTransactionControl, MIGRATIONS_DIR, migrationFiles, sslOptions } from '../../scripts/migrate';
import { describeDb } from './describe-db';
import { TEST_DB_URL_ENV, testSslEnv, unique } from './harness';

/** scripts/migrate.js applyMigrations — idempotency, per-file atomicity, ordering and notice forwarding (the advisory lock is in migrate-lock.db-spec.ts) */
describeDb('scripts/migrate.js runner', () => {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const ssl = sslOptions(testSslEnv());
  const pools: Pool[] = [];
  const dirs: string[] = [];
  let scratchUrl: string;
  let scratchName: string;

  const pool = (url: string) => {
    const created = new Pool({ connectionString: url, ssl, max: 1 });
    pools.push(created);
    return created;
  };
  const migrationsDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ninjalabs-migrate-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return dir;
  };

  beforeEach(async () => {
    scratchName = `ninjalabs_test_runner_${Date.now().toString(36)}_${unique().slice(0, 6)}`;
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`CREATE DATABASE "${scratchName}"`); } finally { await admin.end(); }
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${scratchName}`;
    scratchUrl = parsed.toString();
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it('re-running on the fully migrated test database applies nothing and skips every shipped file in order', async () => {
    const log: string[] = [];
    const result = await applyMigrations(pool(process.env[TEST_DB_URL_ENV]!), { log: (line) => log.push(line) });
    expect(result).toEqual({ applied: [], skipped: migrationFiles() });
    expect(log.filter((line) => !line.startsWith('[notice]'))).toEqual(migrationFiles().map((file) => `skip  ${file}`));
  });

  it('applies files in lexical order, ignores non-.sql files, and records each one', async () => {
    const dir = migrationsDir({
      '0010_b.sql': 'INSERT INTO runner_order (step) VALUES (2);',
      '0002_a.sql': 'CREATE TABLE runner_order (step int); INSERT INTO runner_order (step) VALUES (1);',
      '0011_c.SQL': 'SELECT 1/0;', // wrong extension case → not a migration
      'README.md': 'not sql',
      '0003_notes.sql.bak': 'SELECT 1/0;',
    });
    const db = pool(scratchUrl);
    await expect(applyMigrations(db, { dir })).resolves.toEqual({ applied: ['0002_a.sql', '0010_b.sql'], skipped: [] });
    expect((await db.query('SELECT step FROM runner_order ORDER BY step')).rows).toEqual([{ step: 1 }, { step: 2 }]);
    expect((await db.query('SELECT name FROM _migrations ORDER BY name')).rows.map((r) => r.name)).toEqual(['0002_a.sql', '0010_b.sql']);
    await expect(applyMigrations(db, { dir })).resolves.toEqual({ applied: [], skipped: ['0002_a.sql', '0010_b.sql'] });
  });

  it('a failing file is rolled back entirely (no partial DDL, no _migrations row), earlier files stay, and the error names the file', async () => {
    const dir = migrationsDir({
      '0001_ok.sql': 'CREATE TABLE runner_ok (id int);',
      '0002_half.sql': 'CREATE TABLE runner_half (id int); INSERT INTO runner_half VALUES (1); SELECT * FROM no_such_table;',
      '0003_never.sql': 'CREATE TABLE runner_never (id int);',
    });
    const db = pool(scratchUrl);
    const error = await applyMigrations(db, { dir }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ file: '0002_half.sql', code: '42P01' });
    const tables = await db.query<{ t: string | null }>(
      `SELECT to_regclass(name)::text AS t FROM unnest(ARRAY['runner_ok','runner_half','runner_never']) AS name`);
    expect(tables.rows.map((r) => r.t)).toEqual(['runner_ok', null, null]);
    expect((await db.query('SELECT name FROM _migrations')).rows.map((r) => r.name)).toEqual(['0001_ok.sql']);

    // the operator fixes the file and re-runs: only the remaining files apply
    writeFileSync(join(dir, '0002_half.sql'), 'CREATE TABLE runner_half (id int);');
    await expect(applyMigrations(db, { dir })).resolves.toEqual({ applied: ['0002_half.sql', '0003_never.sql'], skipped: ['0001_ok.sql'] });
  });

  it('forwards RAISE NOTICE output to the log and detaches the listener from the pooled client afterwards', async () => {
    const dir = migrationsDir({ '0001_notice.sql': `DO $$ BEGIN RAISE NOTICE 'backfilled % rows', 3; END $$;` });
    const db = pool(scratchUrl);
    const log: string[] = [];
    await applyMigrations(db, { dir, log: (line) => log.push(line) });
    expect(log).toEqual(['[notice] backfilled 3 rows', 'apply 0001_notice.sql']);

    const client = await db.connect(); // max: 1 → the same client applyMigrations used
    try {
      expect(client.listenerCount('notice')).toBe(0);
    } finally {
      client.release();
    }
  });

  it('refuses a file with top-level transaction control before executing anything: nothing runs, nothing is recorded, and a bad file anywhere aborts the whole run', async () => {
    // The runner wraps each file in BEGIN … COMMIT; a COMMIT in the file would end that transaction early and break per-file atomicity.
    const dir = migrationsDir({
      '0001_ok.sql': 'CREATE TABLE runner_guard_ok (id int);',
      '0002_ok.sql': `DO $$ BEGIN RAISE NOTICE 'body BEGIN/END is fine'; END $$; -- COMMIT; in a comment is fine`,
      '0003_commit.sql': "CREATE TABLE runner_commit (id int);\nSELECT 'COMMIT;';\nCOMMIT;\nSELECT 1;",
    });
    const db = pool(scratchUrl);
    const log: string[] = [];
    await expect(applyMigrations(db, { dir, log: (line) => log.push(line) })).rejects.toMatchObject({
      file: '0003_commit.sql',
      line: 3,
      message: expect.stringContaining('0003_commit.sql:3 COMMIT'),
    });
    expect(log).toEqual([]);
    // not even _migrations was created — the check runs before connecting
    expect((await db.query(`SELECT to_regclass('_migrations')::text AS t`)).rows[0].t).toBeNull();
    expect((await db.query(`SELECT to_regclass('runner_guard_ok')::text AS a, to_regclass('runner_commit')::text AS b`)).rows[0]).toEqual({ a: null, b: null });

    // an already-applied database is refused too, and keeps exactly its rows
    rmSync(join(dir, '0003_commit.sql'));
    await applyMigrations(db, { dir });
    writeFileSync(join(dir, '0004_begin.sql'), 'BEGIN;\nCREATE TABLE runner_begin (id int);\nEND;');
    await expect(applyMigrations(db, { dir })).rejects.toMatchObject({ file: '0004_begin.sql', line: 1 });
    expect((await db.query('SELECT name FROM _migrations ORDER BY name')).rows.map((r) => r.name)).toEqual(['0001_ok.sql', '0002_ok.sql']);
    expect((await db.query(`SELECT to_regclass('runner_begin')::text AS t`)).rows[0].t).toBeNull();
  });

  it('no shipped migration contains top-level transaction control (scanner from scripts/migrate.js)', () => {
    for (const file of migrationFiles(MIGRATIONS_DIR)) {
      expect({ file, hits: findTransactionControl(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')) }).toEqual({ file, hits: [] });
    }
  });

  it('the shipped migrations directory exists and every file name sorts in numeric order (4-digit prefix)', () => {
    const files = migrationFiles(MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    const numbers = files.map((file) => Number(file.slice(0, 4)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length); // no two files share a prefix
  });
});
