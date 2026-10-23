import { rootCertificates } from 'tls';
import { databaseSslOptions } from './database-ssl';

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
});
