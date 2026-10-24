import { ConfigService } from '@nestjs/config';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { BountyOperationsQuery } from './bounty-operations.query';

describe('BountyOperationsQuery', () => {
  function opsDb(status: string) {
    const query = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM bounty WHERE id = $1')) return { rowCount: 1, rows: [{ id: 'b', status, submission_deadline: '2099-01-01' }] };
      if (sql.includes('AS pending')) return { rowCount: 1, rows: [{ pending: 1 }] };
      return { rowCount: 0, rows: [] };
    }));
    return { query, db: { query, tx: jest.fn() } };
  }
  const servicesWith = (db: unknown, selfApproval?: string) => {
    const config = { get: (key: string) => (key === 'PAYOUT_ALLOW_SELF_APPROVAL' ? selfApproval : undefined) } as unknown as ConfigService;
    return new BountyOperationsQuery(db as never, new BountyLifecycleService(), config);
  };

  it('returns the lifecycle with codes and the allowed transitions, the viewer-relative payout flag and the self-approval policy', async () => {
    const { db, query } = opsDb('SUBMISSION_CLOSED');
    const ops = await servicesWith(db).execute('b', 'viewer');
    expect(Object.keys(ops).sort()).toEqual(['applications', 'bounty', 'lifecycle', 'payouts', 'policy', 'rewards', 'submissions']);
    expect(ops.lifecycle.allowedTransitions).toEqual(['IN_REVIEW', 'OPEN']);
    expect(ops.lifecycle.blockerDetails.COMPLETED).toEqual([{ code: 'PENDING_APPLICATIONS', count: 1 }]);
    expect(ops.policy).toEqual({ payoutSelfApprovalAllowed: false });
    const payoutCall = query.mock.calls.find(([sql]) => (sql as string).includes('FROM payout p JOIN bounty_reward'))!;
    expect(payoutCall[0]).toContain('(p.requested_by = $2::uuid) IS TRUE AS requested_by_me');
    expect(payoutCall[1]).toEqual(['b', 'viewer']);
    const submissionSql = query.mock.calls.find(([sql]) => (sql as string).includes('FROM bounty_submission s'))![0] as string;
    expect(submissionSql).toContain('AS recipient_wallet_address');
    expect(submissionSql).toContain("CASE WHEN s.agent_id IS NULL THEN 'USER' ELSE 'AGENT' END AS actor_kind");
  });

  it('reports payoutSelfApprovalAllowed only for PAYOUT_ALLOW_SELF_APPROVAL=true', async () => {
    expect((await servicesWith(opsDb('OPEN').db, ' TRUE ').execute('b', 'viewer')).policy).toEqual({ payoutSelfApprovalAllowed: true });
    expect((await servicesWith(opsDb('OPEN').db, 'yes').execute('b', 'viewer')).policy).toEqual({ payoutSelfApprovalAllowed: false });
  });

  it('404 BOUNTY_NOT_FOUND for a missing/deleted bounty', async () => {
    const query = jest.fn(async () => ({ rowCount: 0, rows: [] }));
    await expect(servicesWith({ query }).execute('b', 'viewer')).rejects.toThrow('BOUNTY_NOT_FOUND');
  });
});
