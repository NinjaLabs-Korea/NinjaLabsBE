import { Controller, Get, Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseService } from '../common/database/database.service';
import { MaintenanceService } from '../common/maintenance/maintenance.service';
import { PgThrottlerStorage } from '../common/throttler/pg-throttler-storage';
import { throttlerModule } from '../common/throttler/throttler-options';
import { describeDb } from './describe-db';
import { createDb, unique } from './harness';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

/**
 * THROTTLER_STORAGE=postgres — 레플리카 두 대(각자 pg Pool을 가진 별도 Nest 앱)가 throttler_storage 한 버킷을 나눠 쓰는지,
 * upsert 하나가 동시 요청에서도 정확히 limit개만 통과시키는지, 창/차단 만료와 정리 크론을 실 Postgres에서 확인한다.
 */
describeDb('Postgres throttler storage shared across instances', () => {
  let db: DatabaseService;
  beforeAll(() => { db = createDb(); });
  afterAll(async () => db.onModuleDestroy());

  async function bootInstance(limit: number, tracker: string): Promise<{ app: INestApplication; url: string }> {
    const own = createDb(); // 인스턴스마다 자기 풀 — 레플리카와 같다
    @Global()
    @Module({ providers: [{ provide: DatabaseService, useValue: own }], exports: [DatabaseService] })
    class InstanceDatabaseModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ NODE_ENV: 'production', THROTTLER_STORAGE: 'postgres' })] }),
        InstanceDatabaseModule,
        // 테스트 실행마다 고유한 tracker — 공유 DB의 이전 실행 행과 섞이지 않게
        throttlerModule([{ ttl: 60_000, limit, getTracker: () => tracker }]),
      ],
      controllers: [PingController],
      providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    return { app, url: `${await app.getUrl()}/ping` };
  }

  it('two app instances share one bucket: the limit holds across replicas, and the 429 carries Retry-After', async () => {
    const saved = process.env.THROTTLER_STORAGE;
    delete process.env.THROTTLER_STORAGE;
    const tracker = unique('ip-');
    const a = await bootInstance(4, tracker);
    const b = await bootInstance(4, tracker);
    try {
      const statuses: number[] = [];
      for (const url of [a.url, b.url, a.url, b.url]) statuses.push((await fetch(url)).status);
      expect(statuses).toEqual([200, 200, 200, 200]);

      // 각 인스턴스만 보면 2회씩이지만 공유 버킷은 4회 — 5번째는 어느 쪽이든 429
      const blocked = await fetch(b.url);
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await fetch(a.url)).status).toBe(429);

      const remaining = (await fetch(a.url)).headers.get('x-ratelimit-remaining');
      expect(remaining).toBeNull(); // still blocked — 429 has no X-RateLimit-* headers
    } finally {
      await a.app.close(); // closes each instance's pool too (DatabaseService.onModuleDestroy)
      await b.app.close();
      if (saved !== undefined) process.env.THROTTLER_STORAGE = saved;
    }
  });

  it('the single upsert admits exactly `limit` hits under concurrency from two pools', async () => {
    const other = createDb();
    try {
      const s1 = new PgThrottlerStorage(db);
      const s2 = new PgThrottlerStorage(other);
      const key = unique('race-');
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) => (i % 2 ? s1 : s2).increment(key, 60_000, 10, 60_000, 'default')),
      );
      expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
      expect(results.filter((r) => r.isBlocked)).toHaveLength(20);
      expect(results.filter((r) => !r.isBlocked).map((r) => r.totalHits).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const row = await db.query<{ hits: number }>(`SELECT hits FROM throttler_storage WHERE key = $1`, [`default:${key}`]);
      expect(row.rows[0].hits).toBe(11); // the 11th hit set the block; blocked hits are not counted
    } finally {
      await other.onModuleDestroy();
    }
  });

  it('starts a fresh window after ttl and a fresh window after the block lapses', async () => {
    const storage = new PgThrottlerStorage(db);
    const key = unique('window-');
    const hit = () => storage.increment(key, 300, 2, 1000, 'default');

    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false, timeToExpire: 1 });
    expect(await hit()).toMatchObject({ totalHits: 2, isBlocked: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false }); // window (300 ms) rolled

    expect(await hit()).toMatchObject({ totalHits: 2, isBlocked: false });
    const blocked = await hit();
    expect(blocked).toMatchObject({ totalHits: 3, isBlocked: true, timeToBlockExpire: 1 });
    await new Promise((resolve) => setTimeout(resolve, 450)); // window over but block (1000 ms) still on
    expect(await hit()).toMatchObject({ totalHits: 3, isBlocked: true });
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(await hit()).toMatchObject({ totalHits: 1, isBlocked: false, timeToBlockExpire: 0 }); // block lapsed → fresh window
  });

  it('the hourly sweep deletes only rows whose window and block have both lapsed', async () => {
    const insert = (key: string, expires: string, blocked: string | null) => db.query(
      `INSERT INTO throttler_storage (key, hits, expires_at, blocked_until)
       VALUES ($1, 1, now() + $2::interval, now() + $3::interval)`,
      [key, expires, blocked],
    );
    const lapsed = unique('sweep-lapsed-');
    const live = unique('sweep-live-');
    const stillBlocked = unique('sweep-blocked-');
    const lapsedBlock = unique('sweep-lapsed-block-');
    await insert(lapsed, '-1 minute', null);
    await insert(live, '1 minute', null);
    await insert(stillBlocked, '-1 minute', '1 minute');
    await insert(lapsedBlock, '-2 minutes', '-1 minute');

    const service = new MaintenanceService(db);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    await service.sweep();

    const left = await db.query<{ key: string }>(`SELECT key FROM throttler_storage WHERE key = ANY($1::text[])`, [[lapsed, live, stillBlocked, lapsedBlock]]);
    expect(left.rows.map((row) => row.key).sort()).toEqual([live, stillBlocked].sort());
  });
});
