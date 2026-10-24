import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { migrationFiles } from '../../../scripts/migrate';
import { DatabaseService } from './database.service';

/** `_migrations`가 없는(한 번도 마이그레이션하지 않은) DB — 모든 파일이 미적용 */
const UNDEFINED_TABLE = '42P01';

/**
 * 배포된 코드가 기대하는 스키마가 DB에 있는지 — supabase/migrations/*.sql 중 `_migrations`에 없는 파일을 찾는다.
 * 순수 함수라 스펙은 두 목록만 넘긴다. 빠진 파일이 있으면 `MIGRATIONS_PENDING: …`로 던진다.
 */
export function missingMigrations(shipped: readonly string[], applied: Iterable<string>): string[] {
  const done = new Set(applied);
  return shipped.filter((file) => !done.has(file));
}

export function assertSchemaCurrent(shipped: readonly string[], applied: Iterable<string>): void {
  const missing = missingMigrations(shipped, applied);
  if (missing.length) {
    throw new Error(`MIGRATIONS_PENDING: run npm run migrate (missing: ${missing.join(', ')})`);
  }
}

/**
 * 기동 시 스키마 검사 — 새 BE 코드가 옛 스키마 위에서 뜨면 `/auth/exchange`·`/auth/refresh`처럼 새 컬럼을 쓰는 라우트가
 * 요청마다 500이 되므로, 아직 적용되지 않은 마이그레이션이 있으면 listen 전에 기동을 거부한다 (main.ts가 메시지를 찍고 exit 1).
 * 배포 순서는 README "배포" 참고: `.railway/railway.ts`의 preDeploy(`npm run migrate`)가 새 컨테이너 기동 전에 적용한다.
 */
@Injectable()
export class SchemaGuard implements OnModuleInit {
  private readonly logger = new Logger(SchemaGuard.name);

  constructor(private readonly db: DatabaseService) {}

  async onModuleInit(): Promise<void> {
    const shipped = migrationFiles();
    assertSchemaCurrent(shipped, await this.appliedMigrations());
    this.logger.log(`schema is current (${shipped.length} migrations, latest ${shipped[shipped.length - 1]})`);
  }

  private async appliedMigrations(): Promise<string[]> {
    try {
      const r = await this.db.query<{ name: string }>('SELECT name FROM _migrations');
      return r.rows.map((row) => row.name);
    } catch (err) {
      if ((err as { code?: string })?.code === UNDEFINED_TABLE) return [];
      throw err;
    }
  }
}
