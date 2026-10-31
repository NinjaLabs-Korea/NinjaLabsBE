import { DynamicModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerModuleOptions, ThrottlerOptions } from '@nestjs/throttler';
import { BootstrapEnv, isProduction } from '../bootstrap-checks';
import { DatabaseService } from '../database/database.service';
import { PgThrottlerStorage } from './pg-throttler-storage';

export type ThrottlerStorageMode = 'postgres' | 'memory';

/**
 * THROTTLER_STORAGE - `postgres`(레플리카 간 공유, 0016 throttler_storage) | `memory`(@nestjs/throttler 기본, 인스턴스별).
 * 미설정/빈 값이면 production은 postgres, 그 외(dev/test)는 memory - 유닛·e2e가 요청마다 DB를 치지 않게.
 * 그 밖의 값은 기동 거부 (오타로 조용히 인스턴스별 한도로 떨어지지 않게).
 */
export function throttlerStorageMode(env: BootstrapEnv): ThrottlerStorageMode {
  const raw = env.THROTTLER_STORAGE?.trim().toLowerCase();
  if (!raw) return isProduction(env) ? 'postgres' : 'memory';
  if (raw === 'postgres' || raw === 'memory') return raw;
  throw new Error(`FATAL: THROTTLER_STORAGE=${JSON.stringify(env.THROTTLER_STORAGE)} - must be "postgres" or "memory" (or unset: postgres in production, memory elsewhere)`);
}

/** memory면 배열(모듈마다 기본 in-memory 저장소), postgres면 공유 PgThrottlerStorage */
export function throttlerModuleOptions(throttlers: ThrottlerOptions[], mode: ThrottlerStorageMode, db: DatabaseService): ThrottlerModuleOptions {
  return mode === 'postgres' ? { throttlers, storage: new PgThrottlerStorage(db) } : throttlers;
}

/**
 * 모든 `ThrottlerModule.forRoot` 자리(app.module 전역, agents.module agent-api, auth.module auth-token)에 이걸 쓴다 -
 * 저장소 선택이 한곳에 있어야 하나만 인스턴스별로 남는 일이 없다 (docs/security.md).
 */
export function throttlerModule(throttlers: ThrottlerOptions[]): DynamicModule {
  return ThrottlerModule.forRootAsync({
    inject: [ConfigService, DatabaseService],
    useFactory: (config: ConfigService, db: DatabaseService) =>
      throttlerModuleOptions(
        throttlers,
        throttlerStorageMode({ NODE_ENV: config.get<string>('NODE_ENV'), THROTTLER_STORAGE: config.get<string>('THROTTLER_STORAGE') }),
        db,
      ),
  });
}
