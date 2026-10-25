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
    expect(service['graceClears'].isRunning).toBe(false);
  });

  it('logs and swallows a failure so the cron keeps running next hour', async () => {
    const { service, query, error } = setup();
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(service.sweep()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('connection reset'));
    expect(service['sweeps'].isRunning).toBe(false);
  });

  it('a failing step does not skip the later cleanups and is named in the log (a stuck session delete must not starve the throttler table)', async () => {
    const { service, query, log, error } = setup([5, 7]); // the two rejected calls below do not consume the default implementation
    query.mockRejectedValueOnce(new Error('first'));
    query.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
    await service.sweep();
    expect(query).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith('maintenance sweep challenges failed: first');
    expect(error).toHaveBeenCalledWith('maintenance sweep sessions failed: canceling statement due to statement timeout');
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=failed sessions=failed login_codes=5 throttles=7');
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

describe('MaintenanceService — robustness', () => {
  function setup(query: jest.Mock) {
    const service = new MaintenanceService({ query } as unknown as DatabaseService);
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, log, error };
  }

  it('reports 0 when the driver gives rowCount null', async () => {
    const { service, log } = setup(jest.fn().mockResolvedValue({ rowCount: null, rows: [] }));
    await service.sweep();
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=0 sessions=0 login_codes=0 throttles=0');
  });

  it('keeps going after a failing statement and logs a non-Error rejection as text', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rowCount: 1 }).mockRejectedValueOnce('lock timeout').mockResolvedValue({ rowCount: 4 });
    const { service, log, error } = setup(query);
    await service.sweep();
    expect(query).toHaveBeenCalledTimes(4);
    expect(error).toHaveBeenCalledWith('maintenance sweep sessions failed: lock timeout');
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=1 sessions=failed login_codes=4 throttles=4');
  });

  it('runs again on the next tick after a failure (the in-progress flag is reset)', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ rowCount: 2 });
    const { service, log } = setup(query);
    await service.sweep();
    await service.sweep();
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=2 sessions=2 login_codes=2 throttles=2');
  });

  it('clearGraceCopies runs at most once at a time and independently of a running sweep', async () => {
    let releaseGrace!: () => void;
    let releaseSweep!: () => void;
    const query = jest.fn((sql: string) => new Promise((resolve) => {
      if (sql.includes('grace_refresh_token')) releaseGrace = () => resolve({ rowCount: 1 });
      else releaseSweep = () => resolve({ rowCount: 0 });
    }));
    const { service, error } = setup(query);
    const sweep = service.sweep(); // first sweep statement in flight
    const grace = service.clearGraceCopies();
    await service.clearGraceCopies(); // overlapping tick → skipped
    expect(query.mock.calls.filter(([sql]) => sql.includes('grace_refresh_token'))).toHaveLength(1);
    releaseGrace();
    await grace;
    for (let i = 0; i < 4; i++) { releaseSweep(); await new Promise((resolve) => setImmediate(resolve)); }
    await sweep;
    expect(error).not.toHaveBeenCalled();
  });

  it('clearGraceCopies logs a non-Error rejection as text', async () => {
    const { service, error } = setup(jest.fn().mockRejectedValue(42));
    await service.clearGraceCopies();
    expect(error).toHaveBeenCalledWith('grace copy cleanup failed: 42');
  });
});

describe('MaintenanceService — shutdown', () => {
  it('beforeApplicationShutdown waits for an in-flight sweep to finish, and no cron runs afterwards', async () => {
    let releaseFirst!: () => void;
    const query = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ rowCount: 1 }); }))
      .mockResolvedValue({ rowCount: 0 });
    const service = new MaintenanceService({ query } as unknown as DatabaseService);
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const sweep = service.sweep();
    let drained = false;
    const shutdown = service.beforeApplicationShutdown().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    releaseFirst();
    await Promise.all([sweep, shutdown]);
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=1 sessions=0 login_codes=0 throttles=0'); // the sweep completed
    query.mockClear();
    await service.sweep();
    await service.clearGraceCopies();
    expect(query).not.toHaveBeenCalled();
  });
});
