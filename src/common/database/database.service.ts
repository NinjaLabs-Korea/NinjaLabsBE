import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { databaseSslOptions } from './database-ssl';
import { databaseTimeoutOptions } from './pool-timeouts';

/** DatabaseService와 트랜잭션 클라이언트(PoolClient)를 함께 받는 최소 쿼리 인터페이스 */
export type QueryRunner = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

type ErrorLogger = Pick<Logger, 'error'>;
/** 체크아웃된 클라이언트의 'error' 이벤트 구독 (PoolClient는 EventEmitter) — 스펙의 최소 대역은 생략할 수 있다 */
type ErrorEvents = {
  on?(event: 'error', listener: (err: Error) => void): unknown;
  removeListener?(event: 'error', listener: (err: Error) => void): unknown;
};

/**
 * 유휴 연결이 끊기면(Postgres/Supabase 재시작, idle timeout, 네트워크 단절) pg Pool이 'error'를 emit한다.
 * 리스너가 없으면 Node가 uncaught 'error' 이벤트로 프로세스를 종료한다 — 풀은 끊긴 클라이언트를 버리고
 * 다음 요청에서 새로 연결하므로 로그만 남기면 된다.
 */
export function attachPoolErrorHandler(pool: Pick<Pool, 'on'>, logger: ErrorLogger): void {
  pool.on('error', (err: Error) => {
    logger.error(`idle database client error (connection discarded): ${err.message}`);
  });
}

/**
 * BEGIN → fn → COMMIT, 실패 시 ROLLBACK. 연결이 트랜잭션 도중 끊기면 ROLLBACK도 실패하는데,
 * 그 에러로 원래 에러를 덮지 않고, 깨진 클라이언트는 release(err)로 풀에서 폐기한다.
 *
 * pg-pool은 체크아웃된 클라이언트에서 idle 'error' 리스너를 떼어낸다(attachPoolErrorHandler는 유휴 연결만 지킨다).
 * 그래서 트랜잭션 도중 소켓이 끊기면(DB 재시작·장애조치·네트워크 단절) 클라이언트가 리스너 없는 'error'를 emit해
 * **프로세스가 죽었다** (uncaught 'error' 이벤트). 체크아웃 동안 리스너를 달아 두고, 받은 에러는 클라이언트 폐기 사유로 쓴다.
 * 폐기되는 클라이언트에는 리스너를 남겨 늦게 도착하는 'error'도 삼킨다.
 */
export async function runInTransaction<T>(
  client: Pick<PoolClient, 'query' | 'release'> & ErrorEvents,
  fn: (client: PoolClient) => Promise<T>,
  logger: ErrorLogger,
): Promise<T> {
  let broken: Error | undefined;
  const onClientError = (err: Error) => {
    broken ??= err;
    logger.error(`database client error during transaction (client discarded): ${err.message}`);
  };
  client.on?.('error', onClientError);
  try {
    await client.query('BEGIN');
    const result = await fn(client as PoolClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      broken ??= rollbackErr as Error;
      logger.error(`ROLLBACK failed, discarding client: ${(rollbackErr as Error).message}`);
    }
    throw err;
  } finally {
    if (!broken) client.removeListener?.('error', onClientError);
    client.release(broken);
  }
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private static readonly logger = new Logger(DatabaseService.name);
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const ssl = {
      PGSSLMODE: config.get<string>('PGSSLMODE'),
      DATABASE_CA_CERT: config.get<string>('DATABASE_CA_CERT'),
    };
    // production에서 CA 없이 TLS를 쓰면 서버 인증서 검증이 빠진다(MITM 취약). 인증서가 아직 발급/배포되지 않았을 수 있어
    // 기동은 막지 않고 부팅 시 한 번만 경고한다 — docs/security.md "DB TLS 인증서 검증"
    if (config.get<string>('NODE_ENV') === 'production' && ssl.PGSSLMODE !== 'disable' && !ssl.DATABASE_CA_CERT?.trim()) {
      DatabaseService.logger.warn(
        'DATABASE_CA_CERT is empty in production — the Postgres server certificate is NOT verified (rejectUnauthorized: false). Set the Supabase CA PEM before go-live.',
      );
    }
    this.pool = new Pool({
      connectionString: config.get<string>('DATABASE_URL'),
      max: 10,
      // Supabase는 TLS 필수 (로컬 Postgres 개발 시 PGSSLMODE=disable).
      // DATABASE_CA_CERT가 있으면 서버 인증서를 검증한다 — database-ssl.ts
      ssl: databaseSslOptions(ssl),
      // 연결/풀 대기/문장/응답 타임아웃 — 블랙홀 DB나 풀 고갈이 요청을 무한히 붙잡지 않게 (pool-timeouts.ts)
      ...databaseTimeoutOptions({
        DB_CONNECTION_TIMEOUT_MS: config.get<string>('DB_CONNECTION_TIMEOUT_MS'),
        DB_STATEMENT_TIMEOUT_MS: config.get<string>('DB_STATEMENT_TIMEOUT_MS'),
      }),
    });
    attachPoolErrorHandler(this.pool, DatabaseService.logger);
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /** 트랜잭션 헬퍼 — 콜백이 throw하면 자동 롤백 */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runInTransaction(await this.pool.connect(), fn, DatabaseService.logger);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
