import { alertBootFailure } from './boot-alert';
import { alertMigrationFailure, warnUnverifiedDbTls } from '../../../scripts/migrate';
import { postOpsAlert, redactSecrets, webhookStatus } from '../../../scripts/ops-alert';

const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/secret';

describe('boot / migration failure alerts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('posts the boot failure (MIGRATIONS_PENDING) to the webhook once', async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 200 }));
    const log = jest.fn();
    await alertBootFailure(
      { OPS_ALERT_WEBHOOK_URL: WEBHOOK, NODE_ENV: 'production' },
      'MIGRATIONS_PENDING: run npm run migrate (missing: 0030_x.sql)',
      log,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.text).toBe('[NinjaLabs production] boot-failure: backend refused to start — MIGRATIONS_PENDING: run npm run migrate (missing: 0030_x.sql)');
    expect(log).not.toHaveBeenCalled();
  });

  it('does nothing without a webhook, and only logs (no throw) when the webhook is unreachable', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError(`fetch failed ${WEBHOOK}`); });
    const log = jest.fn();
    await alertBootFailure({ NODE_ENV: 'production' }, 'x', log, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(alertBootFailure({ OPS_ALERT_WEBHOOK_URL: WEBHOOK }, 'x', log, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('ops alert webhook unreachable for boot failure: TypeError');
    expect(log.mock.calls.flat().join(' ')).not.toContain('secret');
  });

  it('alerts a failed preDeploy migration with the failing file, and logs only when the webhook is down', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const err = Object.assign(new Error('relation "x" already exists'), { file: '0031_y.sql' });
    await alertMigrationFailure({ OPS_ALERT_WEBHOOK_URL: WEBHOOK, RAILWAY_ENVIRONMENT_NAME: 'production' }, err);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.content).toBe(
      '[NinjaLabs production] migration-failure: npm run migrate failed at 0031_y.sql — deploy aborted, previous version keeps serving: relation "x" already exists',
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(alertMigrationFailure({ OPS_ALERT_WEBHOOK_URL: WEBHOOK }, err)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('ops alert webhook unreachable for migration failure: HTTP 500');

    fetchMock.mockClear();
    await alertMigrationFailure({}, err);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a migration that cannot reach the database (dual-stack AggregateError with an empty message) still says why', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const err = new AggregateError([new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')], '');
    await alertMigrationFailure({ OPS_ALERT_WEBHOOK_URL: WEBHOOK, RAILWAY_ENVIRONMENT_NAME: 'production' }, err);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.content).toBe(
      '[NinjaLabs production] migration-failure: npm run migrate failed — deploy aborted, previous version keeps serving: connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432',
    );
  });

  it('webhookStatus accepts only https', () => {
    expect(webhookStatus(undefined)).toBe('unset');
    expect(webhookStatus('  ')).toBe('unset');
    expect(webhookStatus('http://example.com/hook')).toBe('invalid');
    expect(webhookStatus('::')).toBe('invalid');
    expect(webhookStatus(WEBHOOK)).toBe('ok');
  });

  it('postOpsAlert never rejects, even if fetch throws synchronously', async () => {
    const fetchImpl = (() => { throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(postOpsAlert(WEBHOOK, 'x', { fetchImpl })).resolves.toEqual({ ok: false, reason: 'Error' });
  });

  it('redactSecrets leaves ordinary text alone', () => {
    expect(redactSecrets('3 payout(s) pending for over 48h — nft 1111-2222')).toBe('3 payout(s) pending for over 48h — nft 1111-2222');
  });

  it('redactSecrets hides URL credentials even when the password contains a slash', () => {
    expect(redactSecrets('connect failed postgresql://user:pa/ss@db.example.internal:5432/postgres'))
      .toBe('connect failed postgresql://[redacted]@db.example.internal:5432/postgres');
  });

  it('redactSecrets neutralises channel-wide mentions (Discord @everyone/@here, Slack <!channel>)', () => {
    const out = redactSecrets('chain said: @everyone @here <!channel> <!here|here> <!everyone>');
    expect(out).not.toMatch(/@(everyone|here)\b/);
    expect(out).not.toMatch(/<!/);
    expect(out).toContain('@\u200beveryone');
  });
});

describe('migrate.js unverified DB TLS warning', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs an error and alerts once in production without a CA', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const log = jest.fn();
    await warnUnverifiedDbTls({ NODE_ENV: 'production', OPS_ALERT_WEBHOOK_URL: WEBHOOK }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('DATABASE_CA_CERT is empty in production');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.content).toContain('db-tls-unverified');
    expect(body.content).toContain('DATABASE_CA_CERT');
  });

  it('only logs without a webhook, and says nothing with a CA, with TLS off or outside production', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const log = jest.fn();
    await warnUnverifiedDbTls({ NODE_ENV: 'production' }, log);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockClear();
    for (const env of [{ NODE_ENV: 'production', DATABASE_CA_CERT: 'PEM' }, { NODE_ENV: 'production', PGSSLMODE: 'disable' }, { NODE_ENV: 'development' }]) {
      await warnUnverifiedDbTls({ ...env, OPS_ALERT_WEBHOOK_URL: WEBHOOK }, log);
    }
    expect(log).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
