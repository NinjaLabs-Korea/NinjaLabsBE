import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

/**
 * 실 Postgres 통합 테스트 하네스 — `npm run test:db` (jest.db.config.js).
 *
 *   TEST_DATABASE_URL   관리용 접속 문자열 (예: postgresql://postgres:postgres@localhost:5432/postgres). 없으면 모든 스위트 skip.
 *   TEST_PGSSLMODE      기본 disable (로컬/CI Postgres는 TLS 없음). TLS DB면 require.
 *   KEEP_TEST_DB=1      실행 뒤 데이터베이스를 지우지 않는다 (디버깅).
 *
 * global-setup.ts가 매 실행마다 새 데이터베이스(ninjalabs_test_<id>)를 만들고 scripts/migrate.js의 applyMigrations()로
 * supabase/migrations/*.sql을 운영과 같은 코드 경로로 적용한 뒤 접속 문자열을 NINJALABS_TEST_DB_URL에 넣는다.
 * 스위트는 그 DB 위에서 **진짜 DatabaseService와 서비스**를 돌린다 — SQL은 mock하지 않는다. 그래서 mock DB로는 통과해 버리는
 * 파라미터 타입 추론 충돌(42P08), 부분 유니크 인덱스, FOR UPDATE/advisory lock, 트리거 같은 Postgres 동작이 검증된다.
 * 테스트 간 격리는 각 테스트가 고유한 유저/지갑/해시를 만드는 것으로 한다 (스위트는 직렬 실행).
 */
export const TEST_DB_URL_ENV = 'NINJALABS_TEST_DB_URL';
export const TEST_DB_NAME_ENV = 'NINJALABS_TEST_DB_NAME';
export const TEST_JWT_SECRET = 'test-db-jwt-secret-at-least-32-bytes-long!!';

/**
 * 관리용 접속 문자열(TEST_DATABASE_URL). 없으면 로컬에서는 undefined(→ 스위트 skip)지만 **CI(CI=true)에서는 throw** —
 * db-tests 잡의 시크릿/env 가 빠져도 조용히 초록으로 끝나지 않게 한다 (.github/workflows/ci.yml).
 */
export function testDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const url = env.TEST_DATABASE_URL;
  if (!url && env.CI === 'true') {
    throw new Error(
      'TEST_DATABASE_URL is not set while CI=true — the real-database suite must RUN in CI, not skip. ' +
        'Set TEST_DATABASE_URL on the db-tests job (see .github/workflows/ci.yml).',
    );
  }
  return url || undefined;
}

/** 테스트용 ssl 환경 — database-ssl.ts / scripts/migrate.js의 sslOptions()에 그대로 넘긴다 */
export function testSslEnv(): { PGSSLMODE: string; DATABASE_CA_CERT: string | undefined } {
  return { PGSSLMODE: process.env.TEST_PGSSLMODE ?? 'disable', DATABASE_CA_CERT: process.env.DATABASE_CA_CERT };
}

/**
 * 고정 값만 돌려주는 ConfigService 대역 — 진짜 ConfigService는 process.env를 우선하므로 개발자 셸의 DATABASE_URL 등이
 * 테스트 DB 접속을 덮어쓸 수 있다. 서비스들은 `config.get()`만 쓴다.
 */
export function testConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const url = process.env[TEST_DB_URL_ENV];
  if (!url) throw new Error(`${TEST_DB_URL_ENV} is not set — jest.db.config.js global-setup did not run`);
  const values: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    DATABASE_URL: url,
    ...testSslEnv(),
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '14d',
    REWARD_MULTISIG_ADDRESS: 'inj1testmultisig',
    NFT_CONTRACT_ADDRESS: 'inj1testcontract',
    ...overrides,
  };
  return { get: <T = string>(key: string): T | undefined => values[key] as T | undefined } as unknown as ConfigService;
}

/** 진짜 DatabaseService (pg Pool) — afterAll에서 `onApplicationShutdown()`로 닫는다 */
export function createDb(overrides?: Record<string, string | undefined>): DatabaseService {
  return new DatabaseService(testConfig(overrides));
}

export function unique(prefix = ''): string {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

/**
 * 테스트 유저. 기본은 온보딩을 마친 상태(onboarding_step 4 + onboarding_completed_at) - 지원·제출은 온보딩을 마친 사람만 할 수 있다(409 PROFILE_REQUIRED).
 * `onboarded: false`는 구글 로그인 직후 상태(onboarding_step 2, 임시 닉네임)다.
 */
export async function createUser(db: DatabaseService, options: { isAdmin?: boolean; nickname?: string; onboarded?: boolean } = {}): Promise<string> {
  const id = unique();
  const onboarded = options.onboarded ?? true;
  const r = await db.query<{ id: string }>(
    `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step, onboarding_completed_at, is_admin)
     VALUES ($1, $2, $3, '', $5::int, CASE WHEN $5::int >= 4 THEN now() END, $4) RETURNING id`,
    [`google-${id}`, `${id}@example.test`, options.nickname ?? `user_${id.slice(0, 8)}`, options.isAdmin ?? false, onboarded ? 4 : 2],
  );
  return r.rows[0].id;
}

/** 검증된 대표 지갑 (payout 수령·NFT 소유용) */
export async function createPrimaryWallet(db: DatabaseService, userId: string): Promise<{ id: string; address: string }> {
  const address = `inj1${unique()}`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at)
     VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
    [userId, address],
  );
  return { id: r.rows[0].id, address };
}

/** 32바이트 hex tx 해시 (대문자 hex로 만들어 서비스의 소문자 정규화를 함께 확인한다) */
export function fakeTxHash(): string {
  return `0x${randomBytes(32).toString('hex').toUpperCase()}`;
}

/** 밖에서 resolve/reject 하는 Promise — 동시성 스펙에서 트랜잭션 하나를 원하는 지점에 세워 둘 때 쓴다 */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** 이 데이터베이스에서 행/advisory 잠금을 기다리는 백엔드가 하나 이상 생길 때까지 기다린다 (동시성 스펙: "상대가 막혔다"를 확인한 뒤 풀어 준다) */
export async function waitForLockWaiter(db: DatabaseService, what: string): Promise<void> {
  await waitFor(async () => {
    const r = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    return r.rows[0].n > 0;
  }, what);
}

export async function auditActions(db: DatabaseService, entityType: string, entityId: string): Promise<string[]> {
  const r = await db.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, action`,
    [entityType, entityId],
  );
  return r.rows.map((row) => row.action);
}
