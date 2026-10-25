import { rootCertificates } from 'tls';
import { DB_TLS_UNVERIFIED_MESSAGE as JS_MESSAGE, dbTlsUnverifiedInProduction as jsUnverified, sslOptions } from '../../../scripts/migrate';
import { DB_TLS_UNVERIFIED_MESSAGE, databaseSslOptions, dbTlsUnverifiedInProduction } from './database-ssl';

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

  it('uses one message in TS and in migrate.js, naming the variable, the risk and the future refusal', () => {
    expect(JS_MESSAGE).toBe(DB_TLS_UNVERIFIED_MESSAGE);
    expect(DB_TLS_UNVERIFIED_MESSAGE).toMatch(/DATABASE_CA_CERT.*NOT verified.*attacker/s);
  });
});
