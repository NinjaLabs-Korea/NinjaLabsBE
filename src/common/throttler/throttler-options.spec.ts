import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { DatabaseService } from '../database/database.service';
import { PgThrottlerStorage } from './pg-throttler-storage';
import { listSourceFiles } from '../../test-support/source-files';
import { throttlerModule, throttlerModuleOptions, throttlerStorageMode } from './throttler-options';

@Global()
@Module({ providers: [{ provide: DatabaseService, useValue: { query: jest.fn() } }], exports: [DatabaseService] })
class FakeDatabaseModule {}

describe('throttlerStorageMode', () => {
  it('defaults to postgres in production and memory elsewhere', () => {
    expect(throttlerStorageMode({ NODE_ENV: 'production' })).toBe('postgres');
    expect(throttlerStorageMode({ NODE_ENV: 'production', THROTTLER_STORAGE: ' ' })).toBe('postgres');
    expect(throttlerStorageMode({ NODE_ENV: 'development' })).toBe('memory');
    expect(throttlerStorageMode({ NODE_ENV: 'test' })).toBe('memory');
    expect(throttlerStorageMode({})).toBe('memory');
  });

  it('honours an explicit value in any environment (case-insensitive)', () => {
    expect(throttlerStorageMode({ NODE_ENV: 'production', THROTTLER_STORAGE: 'memory' })).toBe('memory');
    expect(throttlerStorageMode({ NODE_ENV: 'development', THROTTLER_STORAGE: 'Postgres' })).toBe('postgres');
  });

  it('refuses to boot on an unknown value instead of silently falling back to per-instance counters', () => {
    expect(() => throttlerStorageMode({ NODE_ENV: 'production', THROTTLER_STORAGE: 'redis' })).toThrow('THROTTLER_STORAGE="redis"');
  });
});

describe('throttlerModuleOptions', () => {
  const throttlers = [{ ttl: 60_000, limit: 120 }];
  it('memory keeps the plain array (one default in-memory store per module)', () => {
    expect(throttlerModuleOptions(throttlers, 'memory', {} as DatabaseService)).toBe(throttlers);
  });
  it('postgres attaches the shared PgThrottlerStorage', () => {
    const options = throttlerModuleOptions(throttlers, 'postgres', {} as DatabaseService);
    expect(options).toEqual({ throttlers, storage: expect.any(PgThrottlerStorage) });
  });
});

describe('throttlerModule wiring', () => {
  async function storageFor(env: Record<string, string>) {
    const app = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => env] }), FakeDatabaseModule, throttlerModule([{ ttl: 1000, limit: 1 }])],
    }).compile();
    const storage = app.get<ThrottlerStorage>(ThrottlerStorage);
    await app.close();
    return storage;
  }

  it('resolves ThrottlerStorage from THROTTLER_STORAGE via ConfigService', async () => {
    const saved = process.env.THROTTLER_STORAGE;
    delete process.env.THROTTLER_STORAGE; // ConfigService prefers process.env over load()
    try {
      expect(await storageFor({ NODE_ENV: 'test', THROTTLER_STORAGE: 'postgres' })).toBeInstanceOf(PgThrottlerStorage);
      expect(await storageFor({ NODE_ENV: 'test', THROTTLER_STORAGE: 'memory' })).toBeInstanceOf(ThrottlerStorageService);
    } finally {
      if (saved !== undefined) process.env.THROTTLER_STORAGE = saved;
    }
  });

  it('every throttler module in src goes through throttlerModule() (no stray per-instance ThrottlerModule.forRoot)', () => {
    const srcRoot = join(__dirname, '..', '..');
    const offenders = listSourceFiles(srcRoot)
      .filter((file) => /ThrottlerModule\.forRoot(Async)?\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(srcRoot, file));
    expect(offenders).toEqual(['common/throttler/throttler-options.ts']);
  });
});
