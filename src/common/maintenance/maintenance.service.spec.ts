import 'reflect-metadata';
import { CronExpression } from '@nestjs/schedule';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { DatabaseService } from '../database/database.service';
import { MaintenanceService } from './maintenance.service';

describe('MaintenanceService crons', () => {
  function setup(counts = [3, 2, 5, 7]) {
    let call = 0;
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: counts[call++] ?? 0, rows: [] }));
    // The sweep statements take no bind parameters — any `$n` creeping in without params is caught here.
    const service = new MaintenanceService({ query: withParamsCheck(query) } as unknown as DatabaseService);
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, query, log, error };
  }

  it('deletes stale challenges, prunes old sessions, expired login codes and lapsed throttler counters, logging counts (grace copies have their own 5-minute cron)', async () => {
    const { service, query, log } = setup();
    await service.sweep();
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls).toHaveLength(4);
    expect(sqls[0]).toContain(`DELETE FROM wallet_verification_challenge WHERE expires_at < now() - interval '1 day'`);
    expect(sqls[1]).toContain('DELETE FROM auth_session');
    expect(sqls[1]).toContain(`(revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`);
    expect(sqls[1]).toContain(`OR expires_at < now() - interval '30 days'`);
    expect(sqls[2]).toContain('DELETE FROM oauth_login_code WHERE expires_at <= now()');
    expect(sqls[3]).toContain('DELETE FROM throttler_storage');
    expect(sqls[3]).toContain('expires_at <= now() AND (blocked_until IS NULL OR blocked_until <= now())');
    expect(sqls.some((sql) => sql.includes('grace_refresh_token'))).toBe(false);
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=3 sessions=2 login_codes=5 throttles=7');
  });

  it('clearGraceCopies runs every 5 minutes and nulls grace copies past the 30 s window, logging only when it cleared some', async () => {
    const cron = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', MaintenanceService.prototype.clearGraceCopies) as { cronTime: string };
    expect(cron.cronTime).toBe(CronExpression.EVERY_5_MINUTES);
    const hourly = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', MaintenanceService.prototype.sweep) as { cronTime: string };
    expect(hourly.cronTime).toBe(CronExpression.EVERY_HOUR);

    const { service, query, log } = setup([4, 0]);
    await service.clearGraceCopies();
    expect(query.mock.calls[0][0]).toContain('UPDATE auth_session SET grace_refresh_token = NULL');
    expect(query.mock.calls[0][0]).toContain(`prev_rotated_at < now() - interval '30 seconds'`);
    expect(log).toHaveBeenCalledWith('grace copies cleared: 4');
    await service.clearGraceCopies();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('clearGraceCopies logs and swallows a failure', async () => {
    const { service, query, error } = setup();
    query.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.clearGraceCopies()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
    expect(service['clearingGrace']).toBe(false);
  });

  it('logs and swallows a failure so the cron keeps running next hour', async () => {
    const { service, query, error } = setup();
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    expect(service['running']).toBe(false);
  });

  it('runs at most once at a time', async () => {
    const { service, query } = setup();
    let release!: () => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ rowCount: 0, rows: [] }); }));
    const first = service.sweep();
    await service.sweep();
    expect(query).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
