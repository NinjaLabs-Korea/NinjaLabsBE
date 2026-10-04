import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService EVM rewards', () => {
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
    const service = new AdminService(db as never);

    await service.createBounty('22222222-2222-4222-8222-222222222222', input);

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
    const service = new AdminService({} as never);

    await expect(service.createBounty('admin', input)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AdminService review safeguards', () => {
  function setup(status: string, revision = 2) {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'OPEN' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sub', status, current_revision_no: revision }] })
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'revision' }] });
    return { query, service: new AdminService({ tx: (callback: (tx: { query: jest.Mock }) => Promise<unknown>) => callback({ query }) } as never) };
  }
  it.each(['APPROVED', 'REJECTED', 'WITHDRAWN', 'REVISION_REQUESTED'])('does not overwrite %s submissions', async (status) => {
    const { service, query } = setup(status);
    await expect(service.reviewSubmission('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_NOT_REVIEWABLE');
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('rejects a review of an outdated revision', async () => {
    await expect(setup('RESUBMITTED', 3).service.reviewSubmission('sub', 'APPROVE', undefined, 'admin', 2)).rejects.toThrow('SUBMISSION_REVISION_CHANGED');
  });
  it('requires actionable feedback for revision requests', async () => {
    await expect(setup('IN_REVIEW').service.reviewSubmission('sub', 'REQUEST_REVISION', ' ', 'admin', 2)).rejects.toThrow('REVISION_COMMENT_REQUIRED');
  });
  it('records the review and audit for the current revision', async () => {
    const { service, query } = setup('IN_REVIEW');
    await expect(service.reviewSubmission('sub', 'REQUEST_REVISION', 'Add tests', 'admin', 2)).resolves.toEqual({ id: 'sub', status: 'REVISION_REQUESTED' });
    expect(query.mock.calls[4][0]).toContain('INSERT INTO submission_review');
    expect(query.mock.calls[5][0]).toContain('INSERT INTO audit_log');
  });
  it('prevents opening a bounty with an unconfirmed reward deposit', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'FUNDING_PENDING' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ unfunded: 1 }] });
    await expect(new AdminService({ query, tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query }) } as never).transitionBounty('bounty', 'OPEN', 'admin')).rejects.toThrow('Bad Request Exception');
  });
});


describe('Abandoned revision requests', () => {
  it('can reject a requested revision with feedback so completion is not permanently blocked', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'IN_REVIEW' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'sub', status: 'REVISION_REQUESTED', current_revision_no: 2 }] })
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 'revision' }] });
    const service = new AdminService({ tx: (fn: (tx: { query: jest.Mock }) => Promise<unknown>) => fn({ query }) } as never);
    await expect(service.reviewSubmission('sub', 'REJECT', 'Revision was not delivered', 'admin', 2)).resolves.toMatchObject({ status: 'REJECTED' });
  });
});
