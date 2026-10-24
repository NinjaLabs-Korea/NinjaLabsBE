import { readFileSync } from 'fs';
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
});
