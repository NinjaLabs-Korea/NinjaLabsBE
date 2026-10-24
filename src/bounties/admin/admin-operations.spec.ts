import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { withParamsCheck } from '../../test-support/expect-params-match';
import { ApplicationReviewService } from '../applications/application-review.service';
import { SubmissionReviewService } from '../submissions/submission-review.service';
import { BountyAdminService } from './bounty-admin.service';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardTokenResolver } from './reward-token.resolver';
import { ConfigService } from '@nestjs/config';

const adminServicesFor = (db: unknown) => {
  const audit = new AuditService(db as never);
  return {
    bounties: new BountyAdminService(db as never, audit, new BountyLifecycleService(), new RewardTokenResolver(new ConfigService()), new ConfigService()),
    applicationReviews: new ApplicationReviewService(db as never, audit),
    submissionReviews: new SubmissionReviewService(db as never, audit),
  };
};

/**
 * `db.query` (pool, autocommit) and `tx.query` (transaction client) are SEPARATE mocks: every mutation below must go through the
 * transaction, so a statement that reaches `db.query` is a bug (it would commit on its own, outside the row locks and the audit row).
 */
function dbWith(txQuery: jest.Mock) {
  const dbQuery = jest.fn();
  return { dbQuery, db: { query: dbQuery, tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query: withParamsCheck(txQuery) }) } };
}

describe('BountyAdminService EVM rewards', () => {
  const originalChainId = process.env.INJECTIVE_EVM_CHAIN_ID;
  const originalUsdcAddress = process.env.USDC_EVM_CONTRACT_ADDRESS;

  afterEach(() => {
    if (originalChainId === undefined) delete process.env.INJECTIVE_EVM_CHAIN_ID;
    else process.env.INJECTIVE_EVM_CHAIN_ID = originalChainId;
    if (originalUsdcAddress === undefined) delete process.env.USDC_EVM_CONTRACT_ADDRESS;
    else process.env.USDC_EVM_CONTRACT_ADDRESS = originalUsdcAddress;
  });

  const input = {
    title: 'USDC bounty', sponsorName: 'Ninja Labs', summary: 'summary',
    description: 'description', requirements: 'requirements',
    evaluationCriteria: 'criteria', category: 'DEV', applicationRequired: false,
    submissionMode: 'DIRECT',
    maxWinners: 1, submissionDeadline: '2026-09-30T00:00:00.000Z',
    reward: { tokenType: 'ERC20', displaySymbol: 'USDC', amount: '12500000' },
  };

  it('persists configured Injective EVM USDC metadata', async () => {
    process.env.INJECTIVE_EVM_CHAIN_ID = '1439';
    process.env.USDC_EVM_CONTRACT_ADDRESS = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';
    const txQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('INSERT INTO bounty\n')) return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const { db, dbQuery } = dbWith(txQuery);
    const services = adminServicesFor(db);

    await services.bounties.create('22222222-2222-4222-8222-222222222222', input);

    const rewardCall = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO bounty_reward'));
    expect(rewardCall?.[1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
      'ERC20',
      'erc20:0x0c382e685bbeefe5d3d9c29e29e341fee8e84c5d',
      '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d',
      1439,
      'USDC',
      '12500000',
      'PENDING_MULTISIG_SETUP',
    ]);
    expect(txQuery.mock.calls.find(([sql]) => sql.includes("UPDATE bounty SET status = 'FUNDING_PENDING'"))?.[1]).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('rejects USDC rewards when the EVM contract is not configured', async () => {
    process.env.INJECTIVE_EVM_CHAIN_ID = '1439';
    delete process.env.USDC_EVM_CONTRACT_ADDRESS;
    const services = adminServicesFor({});

    await expect(services.bounties.create('admin', input)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Admin review safeguards', () => {
  function setup(status: string, revision = 2) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'OPEN' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sub', status, current_revision_no: revision }] })
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'revision' }] });
    const { db, dbQuery } = dbWith(query);
    return { query, dbQuery, services: adminServicesFor(db) };
  }
  it.each(['APPROVED', 'REJECTED', 'WITHDRAWN', 'REVISION_REQUESTED'])('does not overwrite %s submissions', async (status) => {
    const { services, query, dbQuery } = setup(status);
    await expect(services.submissionReviews.review('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_NOT_REVIEWABLE');
    expect(query).toHaveBeenCalledTimes(2);
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it('rejects a review of an outdated revision', async () => {
    await expect(setup('RESUBMITTED', 3).services.submissionReviews.review('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_REVISION_CHANGED');
  });
  it('requires actionable feedback for revision requests', async () => {
    await expect(setup('IN_REVIEW').services.submissionReviews.review('sub', 'REQUEST_REVISION', ' ', 'admin', 2)).rejects.toThrow('REVISION_COMMENT_REQUIRED');
  });
  it('records the review and audit for the current revision, all on the transaction client, with the status bound as a parameter', async () => {
    const { services, query, dbQuery } = setup('IN_REVIEW');
    await expect(services.submissionReviews.review('sub', 'REQUEST_REVISION', 'Add tests', 'admin', 2)).resolves.toEqual({ id: 'sub', status: 'REVISION_REQUESTED' });
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE OF b');
    expect(query.mock.calls[1]).toEqual([expect.stringContaining('FROM bounty_submission WHERE id = $1 FOR UPDATE'), ['sub']]);
    expect(query.mock.calls[2]).toEqual([expect.stringContaining('UPDATE bounty_submission SET status = $2, reviewed_at = now() WHERE id = $1'), ['sub', 'REVISION_REQUESTED']]);
    expect(query.mock.calls[3][1]).toEqual(['sub', 2]); // revision row of the reviewed revision
    expect(query.mock.calls[4][0]).toContain('INSERT INTO submission_review');
    expect(query.mock.calls[4][1]).toEqual(['sub', 'revision', 'admin', 'REQUEST_REVISION', 'Add tests']);
    expect(query.mock.calls[5][0]).toContain('INSERT INTO audit_log');
    expect(query.mock.calls[5][1]).toEqual(['admin', 'SUBMISSION_REQUEST_REVISION', 'bounty_submission', 'sub']);
    expect(dbQuery).not.toHaveBeenCalled();
  });
  it('prevents opening a bounty with an unconfirmed reward deposit', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'FUNDING_PENDING' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ unfunded: 1 }] });
    const { db, dbQuery } = dbWith(query);
    await expect(adminServicesFor(db).bounties.transition('bounty', 'OPEN', 'admin')).rejects.toThrow('Bad Request Exception');
    expect(query.mock.calls[1][1]).toEqual(['bounty', expect.any(Array)]); // lifecycle blockers count the bounty's own rows ($2 = unresolved submission statuses)
    expect(query.mock.calls.some(([sql]) => (sql as string).startsWith('UPDATE bounty'))).toBe(false);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});


describe('BountyAdminService.operations', () => {
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
    return new BountyAdminService(db as never, new AuditService(db as never), new BountyLifecycleService(), new RewardTokenResolver(new ConfigService()), config);
  };

  it('returns the lifecycle with codes and the allowed transitions, the viewer-relative payout flag and the self-approval policy', async () => {
    const { db, query } = opsDb('SUBMISSION_CLOSED');
    const ops = await servicesWith(db).operations('b', 'viewer');
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
    expect((await servicesWith(opsDb('OPEN').db, ' TRUE ').operations('b', 'viewer')).policy).toEqual({ payoutSelfApprovalAllowed: true });
    expect((await servicesWith(opsDb('OPEN').db, 'yes').operations('b', 'viewer')).policy).toEqual({ payoutSelfApprovalAllowed: false });
  });

  it('404 BOUNTY_NOT_FOUND for a missing/deleted bounty', async () => {
    const query = jest.fn(async () => ({ rowCount: 0, rows: [] }));
    await expect(servicesWith({ query }).operations('b', 'viewer')).rejects.toThrow('BOUNTY_NOT_FOUND');
  });
});

describe('Abandoned revision requests', () => {
  it('can reject a requested revision with feedback so completion is not permanently blocked', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'IN_REVIEW' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sub', status: 'REVISION_REQUESTED', current_revision_no: 2 }] })
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'revision' }] });
    const { db, dbQuery } = dbWith(query);
    const services = adminServicesFor(db);
    await expect(services.submissionReviews.review('sub', 'REJECT', 'Revision was not delivered', 'admin', 2)).resolves.toMatchObject({ status: 'REJECTED' });
    expect(query.mock.calls.find(([sql]) => (sql as string).startsWith('UPDATE bounty_submission'))![1]).toEqual(['sub', 'REJECTED']);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
