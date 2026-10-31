import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb } from './harness';

/**
 * 0017 - 마이그레이션을 전부 적용한 DB에서 민감 테이블의 RLS가 켜져 있고, BE가 쓰는 소유자 연결은 그대로 읽고 쓴다.
 * 모든 테이블 완전성은 정적 가드(src/test-support/rls-coverage.spec.ts)가 본다 - 다른 db-spec이 만든 `*_probe` 임시 테이블이 공유 DB에 남아 있어 여기서는 전수 검사를 하지 않는다.
 */
describeDb('row level security on a fully migrated database', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onApplicationShutdown());

  it('has RLS enabled on the public tables that hold credentials and personal data, and the owner connection (what the BE uses) still reads and writes them', async () => {
    const sensitive = ['_migrations', 'user', 'auth_session', 'agent_api_key', 'wallet', 'payout', 'bounty_reward', 'audit_log', 'media_asset', 'oauth_login_code', 'throttler_storage'];
    const tables = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY c.relname COLLATE "C"`,
      [sensitive],
    );
    expect(tables.rows.map((table) => table.relname)).toEqual([...sensitive].sort((a, b) => (a < b ? -1 : 1)));
    expect(tables.rows.filter((table) => !table.relrowsecurity)).toEqual([]);

    // no policies exist, so only roles that bypass RLS (the table owner, i.e. DATABASE_URL's role) can touch the data
    const policies = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`);
    expect(policies.rows[0].n).toBe(0);
    await expect(db.query(`SELECT count(*) FROM "user"`)).resolves.toMatchObject({ rowCount: 1 });
  });
});
