import { Pool } from 'pg';
import { sslOptions } from '../../scripts/migrate';
import { TEST_DB_NAME_ENV, testSslEnv } from './harness';

/** global-setup이 만든 데이터베이스를 지운다 (KEEP_TEST_DB=1이면 남긴다) */
export default async function globalTeardown(): Promise<void> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const name = process.env[TEST_DB_NAME_ENV];
  if (!adminUrl || !name) return;
  if (process.env.KEEP_TEST_DB) {
    process.stdout.write(`[test:db] KEEP_TEST_DB set — leaving database ${name} in place\n`);
    return;
  }
  const admin = new Pool({ connectionString: adminUrl, ssl: sslOptions(testSslEnv()), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    process.stdout.write(`[test:db] dropped database ${name}\n`);
  } finally {
    await admin.end();
  }
}
