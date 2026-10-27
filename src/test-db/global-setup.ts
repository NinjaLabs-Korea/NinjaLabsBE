import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { applyMigrations, sslOptions } from '../../scripts/migrate';
import { TEST_DB_NAME_ENV, TEST_DB_URL_ENV, testDatabaseUrl, testSslEnv } from './harness';

/**
 * 실행마다 새 데이터베이스를 만들고 supabase/migrations를 운영 러너(scripts/migrate.js)와 같은 코드로 적용한다.
 * TEST_DATABASE_URL 이 없으면 로컬에서는 skip 안내만 하고, CI=true 면 testDatabaseUrl()이 throw 해 실행 자체가 실패한다.
 */
export default async function globalSetup(): Promise<void> {
  const adminUrl = testDatabaseUrl();
  if (!adminUrl) {
    process.stdout.write(
      '\n[test:db] TEST_DATABASE_URL is not set - real-database tests are SKIPPED.\n' +
        '[test:db] Point it at a Postgres the user may CREATE DATABASE on, e.g.\n' +
        '[test:db]   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres npm run test:db\n\n',
    );
    return;
  }
  const name = `ninjalabs_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const ssl = sslOptions(testSslEnv());

  const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), ssl, max: 1 });
  try {
    const { applied } = await applyMigrations(pool, { log: (line) => process.stdout.write(`[test:db] ${line}\n`) });
    process.stdout.write(`[test:db] created database ${name}, applied ${applied.length} migration(s)\n`);
  } finally {
    await pool.end();
  }

  process.env[TEST_DB_URL_ENV] = url.toString();
  process.env[TEST_DB_NAME_ENV] = name;
}
