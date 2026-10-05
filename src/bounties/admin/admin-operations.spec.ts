import { BadRequestException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { ApplicationReviewService } from '../applications/application-review.service';
import { SubmissionReviewService } from '../submissions/submission-review.service';
import { BountyAdminService } from './bounty-admin.service';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardTokenResolver } from './reward-token.resolver';
import { ConfigService } from '@nestjs/config';

const adminServicesFor = (db: unknown) => {
  const audit = new AuditService(db as never);
  return {
    bounties: new BountyAdminService(db as never, audit, new BountyLifecycleService(), new RewardTokenResolver(new ConfigService())),
    applicationReviews: new ApplicationReviewService(db as never, audit),
    submissionReviews: new SubmissionReviewService(db as never, audit),
  };
};

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
    const tx = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('INSERT INTO bounty\n')) return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const db = { tx: jest.fn(async (callback: (runner: typeof tx) => unknown) => callback(tx)) };
    const services = adminServicesFor(db);

    await services.bounties.create('22222222-2222-4222-8222-222222222222', input);

    const rewardCall = tx.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO bounty_reward'));
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
    return { query, services: adminServicesFor({ tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query }) }) };
  }
  it.each(['APPROVED', 'REJECTED', 'WITHDRAWN', 'REVISION_REQUESTED'])('does not overwrite %s submissions', async (status) => {
    const { services, query } = setup(status);
    await expect(services.submissionReviews.review('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_NOT_REVIEWABLE');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('rejects a review of an outdated revision', async () => {
    await expect(setup('RESUBMITTED', 3).services.submissionReviews.review('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_REVISION_CHANGED');
  });
  it('requires actionable feedback for revision requests', async () => {
    await expect(setup('IN_REVIEW').services.submissionReviews.review('sub', 'REQUEST_REVISION', ' ', 'admin', 2)).rejects.toThrow('REVISION_COMMENT_REQUIRED');
  });
  it('records the review and audit for the current revision', async () => {
    const { services, query } = setup('IN_REVIEW');
    await expect(services.submissionReviews.review('sub', 'REQUEST_REVISION', 'Add tests', 'admin', 2)).resolves.toEqual({ id: 'sub', status: 'REVISION_REQUESTED' });
    expect(query.mock.calls[4][0]).toContain('INSERT INTO submission_review');
    expect(query.mock.calls[5][0]).toContain('INSERT INTO audit_log');
  });
  it('prevents opening a bounty with an unconfirmed reward deposit', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'FUNDING_PENDING' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ unfunded: 1 }] });
    await expect(adminServicesFor({ query, tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query }) }).bounties.transition('bounty', 'OPEN', 'admin')).rejects.toThrow('Bad Request Exception');
  });
});


describe('Abandoned revision requests', () => {
  it('can reject a requested revision with feedback so completion is not permanently blocked', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'IN_REVIEW' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sub', status: 'REVISION_REQUESTED', current_revision_no: 2 }] })
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'revision' }] });
    const services = adminServicesFor({ tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query }) });
    await expect(services.submissionReviews.review('sub', 'REJECT', 'Revision was not delivered', 'admin', 2)).resolves.toMatchObject({ status: 'REJECTED' });
  });
});
