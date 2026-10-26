import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RewardTokenResolver, rewardMultisigAddressProblem } from './reward-token.resolver';

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
    const erc20 = { tokenType: 'ERC20', tokenContractAddress: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', evmChainId: 1776, displaySymbol: 'WETH', amount: '3' };
    for (const reward of [native, cw20, erc20]) expect(configured().resolve(reward)).toEqual(reward);
  });

  it.each([
    [{ tokenType: 'NATIVE', displaySymbol: 'INJ', amount: '1' }, 'REWARD_TOKEN_DENOM_REQUIRED'],
    [{ tokenType: 'CW20', displaySymbol: 'NINJA', amount: '1' }, 'REWARD_TOKEN_CONTRACT_REQUIRED'],
    [{ tokenType: 'ERC20', evmChainId: 1776, displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
    [{ tokenType: 'ERC20', tokenContractAddress: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
    // DB chk_reward_token는 0x + 40 hex만 받는다 — 오타는 23514 500이 아니라 400
    [{ tokenType: 'ERC20', tokenContractAddress: '0xabc', evmChainId: 1776, displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
    [{ tokenType: 'ERC20', tokenContractAddress: 'inj1notanevmaddress', evmChainId: 1776, displaySymbol: 'WETH', amount: '1' }, 'REWARD_EVM_METADATA_REQUIRED'],
  ])('refuses incomplete token metadata %j → 400 %s', (reward, code) => {
    expect(codeOf(() => configured().resolve(reward))).toBe(code);
  });

  it.each([
    [{ tokenType: 'NATIVE', tokenDenom: 'usdt', displaySymbol: 'INJ' }],
    [{ tokenType: 'NATIVE', tokenDenom: 'peggy0xdAC17F958D2ee523a2206206994597C13D831ec7', displaySymbol: 'USDT' }],
    [{ tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'USDT' }],
    [{ tokenType: 'CW20', tokenContractAddress: 'inj1cw20', displaySymbol: 'INJ' }],
    [{ tokenType: 'ERC20', tokenContractAddress: '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d', evmChainId: 1776, displaySymbol: 'inj' }],
  ])('refuses a symbol that disagrees with its token (an INJ label on a 6-decimal denom renders the wrong amount) %j', (reward) => {
    expect(codeOf(() => configured().resolve({ ...reward, amount: '1000' }))).toBe('REWARD_SYMBOL_DENOM_MISMATCH');
  });

  it('normalizes the native INJ spelling (denom and symbol, any case) to inj / INJ and does not mutate the input', () => {
    const input = { tokenType: 'NATIVE', tokenDenom: 'INJ', displaySymbol: 'inj', amount: '1' };
    expect(configured().resolve(input)).toEqual({ tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1' });
    expect(input).toEqual({ tokenType: 'NATIVE', tokenDenom: 'INJ', displaySymbol: 'inj', amount: '1' });
  });

  it('drops metadata that does not belong to the token type (a NATIVE reward never carries a contract or chain)', () => {
    expect(configured().resolve({ tokenType: 'NATIVE', tokenDenom: 'inj', tokenContractAddress: '0xevil', evmChainId: 1776, displaySymbol: 'INJ', amount: '1' }))
      .toEqual({ tokenType: 'NATIVE', tokenDenom: 'inj', displaySymbol: 'INJ', amount: '1' });
    expect(configured().resolve({ tokenType: 'CW20', tokenContractAddress: 'inj1cw20', evmChainId: 1776, displaySymbol: 'NINJA', amount: '1' }))
      .toEqual({ tokenType: 'CW20', tokenContractAddress: 'inj1cw20', displaySymbol: 'NINJA', amount: '1' });
  });

  it('refuses an ERC-20 on a chain other than the Injective EVM chains (rewards cannot be edited after creation)', () => {
    const erc20 = { tokenType: 'ERC20', tokenContractAddress: USDC_CONTRACT, displaySymbol: 'WETH', amount: '1' };
    expect(codeOf(() => configured().resolve({ ...erc20, evmChainId: 1 }))).toBe('REWARD_EVM_METADATA_REQUIRED');
    expect(configured().resolve({ ...erc20, evmChainId: 1439 })!.evmChainId).toBe(1439);
  });

  it.each(['USDC', 'usdc', 'UsDc'])('%s is pinned to the configured Injective EVM ERC-20, whatever the operator typed', (symbol) => {
    const resolved = configured().resolve({ tokenType: 'NATIVE', tokenDenom: 'peggy0xfake', tokenContractAddress: '0xevil', evmChainId: 1, displaySymbol: symbol, amount: '5' });
    expect(resolved).toEqual({
      tokenType: 'ERC20', tokenDenom: `erc20:${USDC_CONTRACT.toLowerCase()}`, tokenContractAddress: USDC_CONTRACT, evmChainId: 1776,
      displaySymbol: 'USDC', amount: '5', // canonical spelling whatever case the operator typed
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

  it('custody address comes from REWARD_MULTISIG_ADDRESS, with a visible placeholder when unset or empty', () => {
    expect(resolverWith({ REWARD_MULTISIG_ADDRESS: 'inj1multisig' }).custodyAddress()).toBe('inj1multisig');
    expect(resolverWith({ REWARD_MULTISIG_ADDRESS: ` ${ACCOUNT} ` }).custodyAddress()).toBe(ACCOUNT);
    expect(resolverWith().custodyAddress()).toBe('PENDING_MULTISIG_SETUP');
    // a Railway variable left as '' must not store an empty custody address
    expect(resolverWith({ REWARD_MULTISIG_ADDRESS: '' }).custodyAddress()).toBe('PENDING_MULTISIG_SETUP');
    expect(resolverWith({ REWARD_MULTISIG_ADDRESS: '   ' }).custodyAddress()).toBe('PENDING_MULTISIG_SETUP');
  });
});

// real bech32 encodings of 20 bytes 0x11 / 32 bytes 0x22 (same set as scripts/mainnet-preflight.sql)
const ACCOUNT = 'inj1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3t5qxqh';
const CONTRACT = 'inj1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3qunr3kj';
const EVM = '0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d';

describe('rewardMultisigAddressProblem (REWARD_MULTISIG_ADDRESS shape)', () => {
  it.each([ACCOUNT, CONTRACT, EVM, EVM.toLowerCase(), ` ${ACCOUNT} `])('accepts %s', (value) => {
    expect(rewardMultisigAddressProblem(value)).toBeNull();
  });

  it.each([undefined, '', '   '])('%p → not set', (value) => {
    expect(rewardMultisigAddressProblem(value)).toBe('is not set');
  });

  it.each([
    ['inj1multisig', 'is not shaped like'],
    ['cosmos1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3t5qxqh', 'is not shaped like'],
    [ACCOUNT.toUpperCase(), 'is not shaped like'],
    ['PENDING_MULTISIG_SETUP', 'is not shaped like'],
    [`${ACCOUNT.slice(0, -1)}j`, 'invalid bech32 checksum'], // one-character typo
    [`${CONTRACT.slice(0, 10)}x${CONTRACT.slice(11)}`, 'invalid bech32 checksum'],
    ['0x1234', 'is not a valid EVM address'],
    ['0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5D', 'is not a valid EVM address'], // bad checksum casing
  ])('%s → %s', (value, problem) => {
    expect(rewardMultisigAddressProblem(value)).toContain(problem);
  });
});

describe('RewardTokenResolver boot check (production only, logs - never refuses to boot)', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is silent outside production even when unset, and in production with a valid address', () => {
    resolverWith({}).onModuleInit();
    resolverWith({ NODE_ENV: 'development', REWARD_MULTISIG_ADDRESS: 'inj1multisig' }).onModuleInit();
    resolverWith({ NODE_ENV: 'production', REWARD_MULTISIG_ADDRESS: ACCOUNT }).onModuleInit();
    expect(error).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('logs an error in production when REWARD_MULTISIG_ADDRESS is %p (custody falls back to the placeholder)', (value) => {
    expect(() => resolverWith({ NODE_ENV: 'production', REWARD_MULTISIG_ADDRESS: value }).onModuleInit()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^REWARD_MULTISIG_ADDRESS is not set - required in production\. New bounty rewards get custody_address PENDING_MULTISIG_SETUP/));
  });

  it('logs an error in production naming a malformed value (the value is still used - the operator fixes it)', () => {
    const resolver = resolverWith({ NODE_ENV: 'production', REWARD_MULTISIG_ADDRESS: 'inj1multisig' });
    expect(() => resolver.onModuleInit()).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REWARD_MULTISIG_ADDRESS="inj1multisig" is not shaped like an Injective address'));
    expect(resolver.custodyAddress()).toBe('inj1multisig');
  });
});
