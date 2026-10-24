import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardTokenResolver } from './reward-token.resolver';

const USDC_CONTRACT = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';
const resolverWith = (values: Record<string, string | undefined> = {}) =>
  new RewardTokenResolver({ get: (key: string) => values[key] } as unknown as ConfigService);
const configured = () => resolverWith({ USDC_EVM_CONTRACT_ADDRESS: USDC_CONTRACT, INJECTIVE_EVM_CHAIN_ID: '1776' });

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as Error).message;
  }
  return undefined;
};

describe('RewardTokenResolver', () => {
  it('no reward → undefined (a reward-less bounty stays DRAFT)', () => {
    expect(configured().resolve(undefined)).toBeUndefined();
  });

  it('passes a complete NATIVE / CW20 / ERC20 reward through unchanged', () => {
    const native = { tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1' };
    const cw20 = { tokenType: 'CW20', tokenContractAddress: 'inj1cw20', displaySymbol: 'NINJA', amount: '2' };
    const erc20 = { tokenType: 'ERC20', tokenContractAddress: '0xabc', evmChainId: 1776, displaySymbol: 'WETH', amount: '3' };
    for (const reward of [native, cw20, erc20]) expect(configured().resolve(reward)).toEqual(reward);
  });

  it.each([
    [{ tokenType: 'NATIVE', displaySymbol: 'INJ', amount: '1' }, 'REWARD_TOKEN_DENOM_REQUIRED'],
    [{ tokenType: 'CW20', displaySymbol: 'NINJA', amount: '1' }, 'REWARD_TOKEN_CONTRACT_REQUIRED'],
    [{ tokenType: 'ERC20', evmChainId: 1776, displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
    [{ tokenType: 'ERC20', tokenContractAddress: '0xabc', displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
  ])('refuses incomplete token metadata %j → 400 %s', (reward, code) => {
    expect(codeOf(() => configured().resolve(reward))).toBe(code);
  });

  it.each(['USDC', 'usdc', 'UsDc'])('%s is pinned to the configured Injective EVM ERC-20, whatever the operator typed', (symbol) => {
    const resolved = configured().resolve({ tokenType: 'NATIVE', tokenDenom: 'peggy0xfake', tokenContractAddress: '0xevil', evmChainId: 1, displaySymbol: symbol, amount: '5' });
    expect(resolved).toEqual({
      tokenType: 'ERC20', tokenDenom: `erc20:${USDC_CONTRACT.toLowerCase()}`, tokenContractAddress: USDC_CONTRACT, evmChainId: 1776,
      displaySymbol: symbol, amount: '5',
    });
  });

  it.each([
    [{ INJECTIVE_EVM_CHAIN_ID: '1776' }, 'USDC_EVM_CONTRACT_NOT_CONFIGURED'],
    [{ USDC_EVM_CONTRACT_ADDRESS: '0x1234', INJECTIVE_EVM_CHAIN_ID: '1776' }, 'USDC_EVM_CONTRACT_NOT_CONFIGURED'],
    [{ USDC_EVM_CONTRACT_ADDRESS: USDC_CONTRACT }, 'INJECTIVE_EVM_CHAIN_NOT_CONFIGURED'],
    [{ USDC_EVM_CONTRACT_ADDRESS: USDC_CONTRACT, INJECTIVE_EVM_CHAIN_ID: '1' }, 'INJECTIVE_EVM_CHAIN_NOT_CONFIGURED'],
  ])('USDC with config %j → 400 %s', (config, code) => {
    expect(codeOf(() => resolverWith(config).resolve({ tokenType: 'ERC20', displaySymbol: 'USDC', amount: '1' }))).toBe(code);
  });

  it('accepts both Injective EVM chains (testnet 1439, mainnet 1776)', () => {
    for (const chain of ['1439', '1776']) {
      expect(resolverWith({ USDC_EVM_CONTRACT_ADDRESS: USDC_CONTRACT, INJECTIVE_EVM_CHAIN_ID: chain }).resolve({ tokenType: 'ERC20', displaySymbol: 'USDC', amount: '1' })!.evmChainId)
        .toBe(Number(chain));
    }
  });

  it('custody address comes from REWARD_MULTISIG_ADDRESS, with a visible placeholder when unset', () => {
    expect(resolverWith({ REWARD_MULTISIG_ADDRESS: 'inj1multisig' }).custodyAddress()).toBe('inj1multisig');
    expect(resolverWith().custodyAddress()).toBe('PENDING_MULTISIG_SETUP');
  });
});
