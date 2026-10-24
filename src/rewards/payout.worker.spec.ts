import { AlertService } from '../common/alerts/alert.service';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { PayoutWorker } from './payout.worker';

describe('PayoutWorker.monitor', () => {
  function setup(count: number) {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [{ count: String(count) }] }));
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new PayoutWorker({ query: withParamsCheck(query) } as unknown as DatabaseService, alerts as unknown as AlertService);
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    return { worker, query, alerts, warn };
  }

  it('warns and alerts ops (count only, fixed key) when payouts have waited on multisig approval for over 48h', async () => {
    const { worker, query, alerts, warn } = setup(3);
    await worker.monitor();
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL')");
    expect(sql).toContain("requested_at < now() - interval '48 hours'");
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
