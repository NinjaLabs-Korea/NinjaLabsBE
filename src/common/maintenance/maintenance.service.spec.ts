import { withParamsCheck } from '../../test-support/expect-params-match';
import { DatabaseService } from '../database/database.service';
import { MaintenanceService } from './maintenance.service';

describe('MaintenanceService hourly sweep', () => {
  function setup(counts = [3, 1, 2, 5]) {
    let call = 0;
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: counts[call++] ?? 0, rows: [] }));
    // The sweep statements take no bind parameters — any `$n` creeping in without params is caught here.
    const service = new MaintenanceService({ query: withParamsCheck(query) } as unknown as DatabaseService);
    const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return { service, query, log, error };
  }

  it('deletes stale challenges, clears expired grace tokens, prunes old sessions and expired login codes, logging counts', async () => {
    const { service, query, log } = setup();
    await service.sweep();
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    expect(sqls[0]).toContain(`DELETE FROM wallet_verification_challenge WHERE expires_at < now() - interval '1 day'`);
    expect(sqls[1]).toContain('UPDATE auth_session SET grace_refresh_token = NULL');
    expect(sqls[1]).toContain(`prev_rotated_at < now() - interval '30 seconds'`);
    expect(sqls[2]).toContain('DELETE FROM auth_session');
    expect(sqls[2]).toContain(`(revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`);
    expect(sqls[2]).toContain(`OR expires_at < now() - interval '30 days'`);
    expect(sqls[3]).toContain('DELETE FROM oauth_login_code WHERE expires_at <= now()');
    expect(log).toHaveBeenCalledWith('maintenance sweep: challenges=3 sessions=2 grace_tokens_cleared=1 login_codes=5');
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
