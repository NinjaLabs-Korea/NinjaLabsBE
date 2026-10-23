import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseService } from '../common/database/database.service';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { JWT_SECRET } from './jwt-secret';

/** AuthModule은 전역 DatabaseModule을 기대한다 — 여기서는 SQL을 치지 않으므로 빈 대역을 전역으로 제공한다 */
@Global()
@Module({ providers: [{ provide: DatabaseService, useValue: {} }], exports: [DatabaseService] })
class FakeDatabaseModule {}

const ENV_KEYS = ['JWT_SECRET', 'JWT_ACCESS_TTL', 'NODE_ENV', 'GOOGLE_CLIENT_SECRET', 'JWT_REFRESH_TTL'] as const;
const STRONG_SECRET = 'file-secret-from-dotenv-'.padEnd(48, 'x');

describe('AuthModule boots its secrets from the .env ConfigModule loads (not import-time process.env)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  const dirs: string[] = [];
  const apps: TestingModule[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** .env 파일을 써 두고 ConfigModule.forRoot({ envFilePath })로 읽게 한 뒤 AuthModule을 올린다 (onModuleInit까지) */
  async function boot(env: string): Promise<TestingModule> {
    const dir = mkdtempSync(join(tmpdir(), 'ninjalabs-auth-env-'));
    dirs.push(dir);
    const envFilePath = join(dir, '.env');
    writeFileSync(envFilePath, env);
    const app = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath }), FakeDatabaseModule, AuthModule],
    }).compile();
    try {
      await app.init();
    } catch (err) {
      // Nest 11 close() re-awaits the failed init — swallow that echo, surface the original boot error
      await app.close().catch(() => undefined);
      throw err;
    }
    apps.push(app);
    return app;
  }

  it('signs and verifies with the JWT_SECRET from the .env file, and AuthService shares that exact value', async () => {
    const app = await boot(`JWT_SECRET=${STRONG_SECRET}\nJWT_ACCESS_TTL=5m\nJWT_REFRESH_TTL=7d\n`);
    const jwt = app.get(JwtService);
    const token = jwt.sign({ sub: 'user-1', typ: 'access' });

    expect(jwt.verify(token, { secret: STRONG_SECRET })).toMatchObject({ sub: 'user-1' });
    expect(() => jwt.verify(token, { secret: 'dev-only-secret' })).toThrow();
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
    expect(exp - iat).toBe(300); // JWT_ACCESS_TTL from the same file

    // single provider: JwtModule, the JWT_SECRET token and AuthService's grace key are the same string
    expect(app.get<string>(JWT_SECRET)).toBe(STRONG_SECRET);
    const auth = app.get(AuthService);
    expect(auth['graceSecret']).toBe(STRONG_SECRET);
    expect(auth['refreshTtl']).toBe('7 days');
    await expect(auth.verifyAccessToken(token)).resolves.toEqual({ userId: 'user-1', isAdmin: false });
  });

  it('falls back to the dev secret outside production when the file only has the placeholder', async () => {
    const app = await boot('JWT_SECRET=change-me-long-random-string\n');
    expect(app.get<string>(JWT_SECRET)).toBe('dev-only-secret');
    const token = app.get(JwtService).sign({ sub: 'u', typ: 'access' });
    expect(app.get(JwtService).verify(token, { secret: 'dev-only-secret' })).toMatchObject({ sub: 'u' });
  });

  it('refuses to boot in production with a weak JWT_SECRET (the provider factory throws before anything is signed)', async () => {
    await expect(boot(`NODE_ENV=production\nGOOGLE_CLIENT_SECRET=g\nJWT_SECRET=${'s'.repeat(31)}\n`))
      .rejects.toThrow(/JWT_SECRET must be set to a random value of at least 32 bytes in production/);
  });

  it('refuses to boot in production without GOOGLE_CLIENT_SECRET (checked in onModuleInit through ConfigService)', async () => {
    await expect(boot(`NODE_ENV=production\nJWT_SECRET=${STRONG_SECRET}\n`))
      .rejects.toThrow(/GOOGLE_CLIENT_SECRET must be set in production/);
  });

  it('boots in production when both secrets are present in the file', async () => {
    const app = await boot(`NODE_ENV=production\nGOOGLE_CLIENT_SECRET=g\nJWT_SECRET=${STRONG_SECRET}\n`);
    expect(app.get<string>(JWT_SECRET)).toBe(STRONG_SECRET);
  });
});
