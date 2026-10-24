import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * production 배포 설정(.railway/railway.ts)의 오리진 허용 목록에 개발용 오리진이 섞이지 않았는지 — 텍스트로 검사한다
 * (railway/iac는 ESM이라 jest로 실행하지 않는다). 로컬 오리진은 .env로만 준다 (README "로컬 오리진").
 */
describe('.railway/railway.ts production origins', () => {
  const source = readFileSync(join(__dirname, '..', '..', '.railway', 'railway.ts'), 'utf8');
  const envValue = (key: string) => new RegExp(`${key}:\\s*"([^"]*)"`).exec(source)?.[1];

  it('CORS_ORIGINS lists only https origins (no localhost / 127.0.0.1 / http)', () => {
    const origins = envValue('CORS_ORIGINS')?.split(',') ?? [];
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins) expect(origin).toMatch(/^https:\/\/(?!localhost|127\.)/);
  });

  it('AUTH_ALLOWED_REDIRECT_ORIGINS and AUTH_SUCCESS_REDIRECT, if set, are https and not local', () => {
    for (const key of ['AUTH_ALLOWED_REDIRECT_ORIGINS', 'AUTH_SUCCESS_REDIRECT']) {
      for (const origin of (envValue(key) ?? '').split(',').filter(Boolean)) expect([key, origin]).toEqual([key, expect.stringMatching(/^https:\/\/(?!localhost|127\.)/)]);
    }
  });

  it('THROTTLER_STORAGE is postgres so rate limits are shared across replicas (docs/security.md)', () => {
    expect(envValue('THROTTLER_STORAGE')).toBe('postgres');
  });

  it('OPS_ALERT_WEBHOOK_URL is a secret: preserve()d, never a literal in git', () => {
    expect(source).toMatch(/OPS_ALERT_WEBHOOK_URL:\s*preserve\(\)/);
    expect(envValue('OPS_ALERT_WEBHOOK_URL')).toBeUndefined();
  });

  it.each(['DATABASE_URL', 'DATABASE_CA_CERT', 'GOOGLE_CLIENT_SECRET', 'JWT_SECRET', 'MASTER_WALLET_MNEMONIC', 'REWARD_MULTISIG_ADDRESS', 'INJECTIVE_GRPC_ENDPOINT', 'TURNSTILE_SECRET_KEY'])(
    '%s is preserve()d (set in the Railway dashboard, never a literal in git)',
    (key) => {
      expect(source).toMatch(new RegExp(`\\b${key}:\\s*preserve\\(\\)`));
      expect(envValue(key)).toBeUndefined();
    },
  );
});

/**
 * 코드가 읽는 env 키가 전부 railway.ts에 있는지 — IaC는 선언형이라 railway.ts에 없는 키를 대시보드에서만 넣으면
 * `railway config apply`가 지울 수 있다 (docs/runbook.md §1). 의도적으로 빼는 키는 아래 목록에 사유와 함께 둔다.
 */
describe('.railway/railway.ts covers every env key the code reads', () => {
  const root = join(__dirname, '..', '..');
  const railway = readFileSync(join(root, '.railway', 'railway.ts'), 'utf8');
  const NOT_IN_RAILWAY: Record<string, string> = {
    PORT: 'injected by Railway',
    RAILWAY_ENVIRONMENT_NAME: 'injected by Railway',
    PGSSLMODE: 'local Postgres only (disable); production uses TLS',
    AUTH_ALLOWED_REDIRECT_ORIGINS: 'optional public value — added as a literal when a second FE origin exists (AUTH_SUCCESS_REDIRECT origin is always allowed)',
  };

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'test-db' || name === 'test-e2e' || name === 'test-support' ? [] : sourceFiles(path);
      return /\.(ts|js)$/.test(name) && !/\.(spec|d)\.ts$/.test(name) ? [path] : [];
    });
  }

  const readKeys = new Set<string>();
  for (const file of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'scripts'))]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bget(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g)) readKeys.add(m[1]);
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) readKeys.add(m[1]);
  }

  it('finds the keys it is supposed to scan (sanity)', () => {
    expect([...readKeys]).toEqual(expect.arrayContaining(['DATABASE_URL', 'REWARD_MULTISIG_ADDRESS', 'DB_STATEMENT_TIMEOUT_MS', 'OPS_ALERT_WEBHOOK_URL']));
  });

  it('every key read by code is declared in railway.ts (value or preserve()) or listed as intentionally absent', () => {
    const missing = [...readKeys].filter((key) => !new RegExp(`\\b${key}:`).test(railway) && !(key in NOT_IN_RAILWAY)).sort();
    expect(missing).toEqual([]);
  });
});
