import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { databaseSslOptions } from './database-ssl';

/** DatabaseService와 트랜잭션 클라이언트(PoolClient)를 함께 받는 최소 쿼리 인터페이스 */
export type QueryRunner = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

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
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params as any[]);
  }

  /** 트랜잭션 헬퍼 — 콜백이 throw하면 자동 롤백 */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
