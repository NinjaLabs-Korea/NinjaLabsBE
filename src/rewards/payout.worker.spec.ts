import { AlertService } from '../common/alerts/alert.service';
import { DatabaseService } from '../common/database/database.service';
import { PayoutWorker } from './payout.worker';

describe('PayoutWorker', () => {
  function setup(count: number) {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [{ count: String(count) }] }));
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new PayoutWorker({ query } as unknown as DatabaseService, alerts as unknown as AlertService);
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    return { worker, query, alerts, warn };
  }

  it('alerts ops (count only, fixed key) when payouts have waited for approval for over 48h', async () => {
    const { worker, query, alerts, warn } = setup(3);
    await worker.monitor();
    expect((query.mock.calls[0] as unknown as [string])[0]).toContain(`requested_at < now() - interval '48 hours'`);
    expect(warn).toHaveBeenCalledWith('3 payout(s) pending multisig approval for over 48h');
    expect(alerts.notify).toHaveBeenCalledWith('payout-unapproved-48h', expect.stringContaining('3 payout(s) pending multisig approval for over 48h'));
  });

  it('stays quiet when nothing is stale', async () => {
    const { worker, alerts, warn } = setup(0);
    await worker.monitor();
    expect(warn).not.toHaveBeenCalled();
    expect(alerts.notify).not.toHaveBeenCalled();
  });
});
