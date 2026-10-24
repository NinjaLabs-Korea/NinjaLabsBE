import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterAgentDto } from './agents.controller';

// 컨트롤러가 서비스 → wallet-signature / injective-public-key → @injectivelabs/sdk-ts(ESM)를 끌어오므로 서명 검증 모듈과 sdk-ts를 대체한다
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const failedFields = async (body: object) =>
  (await validate(plainToInstance(RegisterAgentDto, body))).map((error) => error.property).sort();

describe('RegisterAgentDto', () => {
  const wallet = { walletAddress: '0x1111111111111111111111111111111111111111' };

  it('bounds name to 1..100 (trimmed, matching the FE input maxLength) and description to 1000', async () => {
    expect(await failedFields({ ...wallet, name: 'n'.repeat(100), description: 'd'.repeat(1000) })).toEqual([]);
    expect(await failedFields({ ...wallet, name: 'n'.repeat(101), description: 'd'.repeat(1001) })).toEqual(['description', 'name']);
    expect(await failedFields({ ...wallet, name: '   ' })).toEqual(['name']);
    expect(plainToInstance(RegisterAgentDto, { ...wallet, name: '  bot  ' }).name).toBe('bot');
  });
});
