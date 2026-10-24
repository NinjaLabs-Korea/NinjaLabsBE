import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { applyMigrations, MIGRATION_LOCK_KEY, migrationFiles, sslOptions } from '../../scripts/migrate';
import { describeDb } from './describe-db';
import { testSslEnv, unique } from './harness';

/**
 * scripts/migrate.js는 실행 전체를 pg_advisory_lock(MIGRATION_LOCK_KEY)로 감싼다 — 겹친 두 배포가 같은 DDL을 두 번 돌리지 않도록.
 * advisory lock은 데이터베이스 단위이므로 테스트마다 빈 데이터베이스를 새로 만든다.
 */
describeDb('scripts/migrate.js advisory lock', () => {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const ssl = sslOptions(testSslEnv());
  let name: string;
  let url: string;
  const pools: Pool[] = [];
  const pool = (max = 1) => {
    const created = new Pool({ connectionString: url, ssl, max });
    pools.push(created);
    return created;
  };

  beforeEach(async () => {
    name = `ninjalabs_test_lock_${Date.now().toString(36)}_${unique().slice(0, 6)}`;
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${name}`;
    url = parsed.toString();
  });

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  const lockWaiters = async (observer: Pool) => (await observer.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
  )).rows[0].n;

  it('waits while another session holds the migration lock, then applies everything (works on a max:1 pool)', async () => {
    const holder = await pool().connect();
    await holder.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    const log: string[] = [];
    const run = applyMigrations(pool(1), { log: (line) => log.push(line) });
    const observer = pool();
    const deadline = Date.now() + 10_000;
    while ((await lockWaiters(observer)) === 0) {
      if (Date.now() > deadline) throw new Error('applyMigrations never waited on the advisory lock');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(log).toContain('wait  another migration run holds the lock');
    expect((await observer.query(`SELECT to_regclass('_migrations') AS t`)).rows[0].t).toBeNull(); // nothing ran yet
    await holder.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
    holder.release();
    await expect(run).resolves.toEqual({ applied: migrationFiles(), skipped: [] });
  });

  it('two concurrent runs (two deploys) apply every file exactly once and both succeed', async () => {
    const [a, b] = await Promise.all([applyMigrations(pool(2)), applyMigrations(pool(2))]);
    expect([...a.applied, ...b.applied].sort()).toEqual(migrationFiles());
    expect([a.applied.length, b.applied.length].sort((x, y) => x - y)[0]).toBe(0); // the second one only skipped
    const rows = await pool().query<{ name: string }>(`SELECT name FROM _migrations`);
    expect(rows.rows.map((row) => row.name).sort()).toEqual(migrationFiles());
  });

  it('releases the lock in finally when a migration fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ninjalabs-lock-'));
    try {
      writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE lock_probe (id int);');
      writeFileSync(join(dir, '0002_broken.sql'), 'SELECT * FROM no_such_table;');
      await expect(applyMigrations(pool(1), { dir })).rejects.toMatchObject({ file: '0002_broken.sql' });
      const other = pool();
      expect((await other.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [MIGRATION_LOCK_KEY])).rows[0].ok).toBe(true);
      await other.query('SELECT pg_advisory_unlock_all()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
