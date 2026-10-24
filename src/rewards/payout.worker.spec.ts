import { AlertService } from '../common/alerts/alert.service';
import { createMockDb } from '../test-support/mock-db';
import { PayoutWorker } from './payout.worker';

describe('PayoutWorker.monitor', () => {
  function setup(count: number) {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [{ count: String(count) }] }));
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new PayoutWorker(createMockDb({ query }).database, alerts as unknown as AlertService);
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

describe('PayoutWorker — overlap and shutdown', () => {
  it('skips an overlapping tick, waits for the in-flight check on shutdown, and runs nothing afterwards', async () => {
    let release!: () => void;
    const query = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ rowCount: 1, rows: [{ count: '0' }] }); }))
      .mockResolvedValue({ rowCount: 1, rows: [{ count: '0' }] });
    const worker = new PayoutWorker(createMockDb({ query }).database, { notify: jest.fn() } as unknown as AlertService);
    const first = worker.monitor();
    await worker.monitor(); // overlapping tick
    expect(query).toHaveBeenCalledTimes(1);
    let drained = false;
    const shutdown = worker.beforeApplicationShutdown().then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release();
    await Promise.all([first, shutdown]);
    await worker.monitor();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
