import { withParamsCheck } from '../test-support/expect-params-match';
import { PayoutWorker } from './payout.worker';

function setup(count: string) {
  const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 1, rows: [{ count }] }));
  const worker = new PayoutWorker({ query: withParamsCheck(query) } as never);
  const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
  return { worker, query, warn };
}

describe('PayoutWorker.monitor', () => {
  it('warns with the number of payouts waiting on multisig approval for over 48h', async () => {
    const { worker, query, warn } = setup('3');
    await worker.monitor();
    expect(warn).toHaveBeenCalledWith('3 payout(s) pending multisig approval for over 48h');
    const sql = query.mock.calls[0][0];
    expect(sql).toContain("status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL')");
    expect(sql).toContain("requested_at < now() - interval '48 hours'");
  });

  it('stays silent when nothing is stale', async () => {
    const { worker, warn } = setup('0');
    await worker.monitor();
    expect(warn).not.toHaveBeenCalled();
  });
});
