import { spawnSync } from 'child_process';
import { join } from 'path';
import { rootCertificates } from 'tls';
import { DB_TLS_UNVERIFIED_MESSAGE as JS_MESSAGE, assertDbTlsVerifiedInProduction as jsAssert, dbTlsUnverifiedInProduction as jsUnverified, sslOptions } from '../../../scripts/migrate';
import { DB_TLS_UNVERIFIED_MESSAGE, assertDbTlsVerifiedInProduction, databaseSslOptions, dbTlsUnverifiedInProduction } from './database-ssl';

describe('databaseSslOptions', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

  it('keeps the legacy behaviour when no CA is configured', () => {
    expect(databaseSslOptions({})).toEqual({ rejectUnauthorized: false });
    expect(databaseSslOptions({ DATABASE_CA_CERT: '   ' })).toEqual({ rejectUnauthorized: false });
  });

  it('disables TLS only with PGSSLMODE=disable', () => {
    expect(databaseSslOptions({ PGSSLMODE: 'disable', DATABASE_CA_CERT: pem })).toBeUndefined();
  });

  it('verifies the server certificate against DATABASE_CA_CERT, accepting \\n-escaped PEM', () => {
    expect(databaseSslOptions({ DATABASE_CA_CERT: pem })).toEqual({ ca: [...rootCertificates, pem], rejectUnauthorized: true });
    const escaped = pem.replace(/\n/g, '\\n');
    expect(databaseSslOptions({ DATABASE_CA_CERT: `${escaped}\n` })).toEqual({ ca: [...rootCertificates, pem], rejectUnauthorized: true });
  });

  it('keeps the Node root store alongside the custom CA so publicly-signed poolers still verify', () => {
    const options = databaseSslOptions({ DATABASE_CA_CERT: pem }) as { ca: string[] };
    expect(rootCertificates.length).toBeGreaterThan(0);
    expect(options.ca.slice(0, rootCertificates.length)).toEqual([...rootCertificates]);
    expect(options.ca[options.ca.length - 1]).toBe(pem);
    expect(options.ca).toHaveLength(rootCertificates.length + 1);
  });

  it('scripts/migrate.js sslOptions (a copy — it cannot import TS) answers every env the same way', () => {
    for (const env of [
      {},
      { PGSSLMODE: 'disable' },
      { PGSSLMODE: 'require' },
      { PGSSLMODE: 'disable', DATABASE_CA_CERT: pem },
      { DATABASE_CA_CERT: '   ' },
      { DATABASE_CA_CERT: pem },
      { DATABASE_CA_CERT: `${pem.replace(/\n/g, '\\n')}\n` },
    ]) {
      expect(sslOptions(env)).toEqual(databaseSslOptions(env));
    }
  });

  it.each([
    [{ NODE_ENV: 'production' }, true],
    [{ NODE_ENV: 'production', PGSSLMODE: 'require', DATABASE_CA_CERT: '  ' }, true],
    [{ NODE_ENV: 'production', DATABASE_CA_CERT: pem }, false],
    [{ NODE_ENV: 'production', PGSSLMODE: 'disable' }, false],
    [{ NODE_ENV: 'development' }, false],
    [{}, false],
  ])('flags unverified TLS only in production with TLS on and no CA (TS and migrate.js copy agree): %p', (env, flagged) => {
    expect(dbTlsUnverifiedInProduction(env)).toBe(flagged);
    expect(jsUnverified(env)).toBe(flagged);
  });

  it('uses one message in TS and in migrate.js, naming the variable and the risk', () => {
    expect(JS_MESSAGE).toBe(DB_TLS_UNVERIFIED_MESSAGE);
    expect(DB_TLS_UNVERIFIED_MESSAGE).toMatch(/^FATAL: DATABASE_CA_CERT.*NOT be verified.*attacker/s);
  });

  it.each([
    [{ NODE_ENV: 'production' }],
    [{ NODE_ENV: 'production', PGSSLMODE: 'require', DATABASE_CA_CERT: '  ' }],
  ])('refuses in production with TLS on and no CA, in TS and in migrate.js: %p', (env) => {
    expect(() => assertDbTlsVerifiedInProduction(env)).toThrow(DB_TLS_UNVERIFIED_MESSAGE);
    expect(() => jsAssert(env)).toThrow(DB_TLS_UNVERIFIED_MESSAGE);
  });

  it.each([
    [{ NODE_ENV: 'production', DATABASE_CA_CERT: pem }],
    [{ NODE_ENV: 'production', PGSSLMODE: 'disable' }],
    [{ NODE_ENV: 'development' }],
    [{ NODE_ENV: 'test' }],
    [{}],
  ])('does not refuse with a CA, with TLS off or outside production: %p', (env) => {
    expect(() => assertDbTlsVerifiedInProduction(env)).not.toThrow();
    expect(() => jsAssert(env)).not.toThrow();
  });

  it('npm run migrate exits 1 with the FATAL message before touching the database (preDeploy stops the deploy)', () => {
    const result = spawnSync(process.execPath, [join(__dirname, '../../../scripts/migrate.js')], {
      // 닿지 않는 주소: 검사가 연결보다 먼저라면 접속 시도 없이 바로 끝난다. DOTENV는 .env가 있어도 이 값들을 덮지 못한다
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: 'postgresql://u@127.0.0.1:1/x' },
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DB_TLS_UNVERIFIED_MESSAGE);
    expect(result.stdout).not.toContain('apply ');
  });
});
