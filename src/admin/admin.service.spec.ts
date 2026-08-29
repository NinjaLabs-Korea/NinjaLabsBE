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
