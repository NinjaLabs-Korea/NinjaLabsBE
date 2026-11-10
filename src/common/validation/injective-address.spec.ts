import { randomBytes } from 'crypto';
import { getAddress } from 'ethers';
import {
  bech32ChecksumValid, evmAddressOf, INJECTIVE_ACCOUNT_ADDRESS, maskAddress, parsePayoutAddress, tryParsePayoutAddress,
} from './injective-address';

/**
 * 벡터는 BIP-173 참조 구현과 `@injectivelabs/sdk-ts` getInjectiveAddress로 만든 값이다(sdk-ts는 ESM 전용이라 jest가 못 부른다:
 * 2026-11-10 무작위 2000개 주소를 node에서 sdk-ts와 대조해 0건 불일치를 확인했다. 헬퍼를 바꾸면 같은 대조를 다시 한다).
 */
const EVM_11 = '0x1111111111111111111111111111111111111111';
const INJ_11 = 'inj1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3t5qxqh';
const EVM_AB = '0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB'; // EIP-55 표기
const INJ_AB = 'inj14w46h2at4w46h2at4w46h2at4w46h2atk8d3r9';
const EIP55_SAMPLE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 명세의 예시
const INJ_CONTRACT_32_BYTES = 'inj1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs08ay07';
const COSMOS_11 = 'cosmos1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3pahzj0';
const INJ_ZERO = 'inj1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqe2hm49';

describe('parsePayoutAddress', () => {
  it('accepts 0x in lowercase, uppercase hex and correct EIP-55 casing, and returns lowercase inj1 + EIP-55 0x', () => {
    for (const input of [EVM_AB.toLowerCase(), `0x${EVM_AB.slice(2).toUpperCase()}`, EVM_AB]) {
      expect(parsePayoutAddress(input)).toEqual({ injective: INJ_AB, evm: EVM_AB });
    }
    expect(parsePayoutAddress(EVM_11)).toEqual({ injective: INJ_11, evm: EVM_11 });
    expect(parsePayoutAddress(EIP55_SAMPLE).evm).toBe(EIP55_SAMPLE);
  });

  it('rejects a mixed-case 0x address whose EIP-55 checksum is wrong', () => {
    const flipped = `${EIP55_SAMPLE.slice(0, 3)}${EIP55_SAMPLE[3] === 'A' ? 'a' : 'A'}${EIP55_SAMPLE.slice(4)}`;
    expect(flipped.toLowerCase()).toBe(EIP55_SAMPLE.toLowerCase());
    expect(tryParsePayoutAddress(flipped)).toBeNull();
  });

  it('accepts lowercase inj1 and folds an all-uppercase inj1 to lowercase', () => {
    expect(parsePayoutAddress(INJ_AB)).toEqual({ injective: INJ_AB, evm: EVM_AB });
    expect(parsePayoutAddress(INJ_AB.toUpperCase())).toEqual({ injective: INJ_AB, evm: EVM_AB });
  });

  it('trims surrounding whitespace only', () => {
    expect(parsePayoutAddress(`  ${INJ_11}\n`).injective).toBe(INJ_11);
    expect(parsePayoutAddress(` ${EVM_11} `).injective).toBe(INJ_11);
    expect(tryParsePayoutAddress(`${INJ_11.slice(0, 10)} ${INJ_11.slice(10)}`)).toBeNull();
  });

  it.each([
    ['mixed-case inj1', `${INJ_AB.slice(0, 10).toUpperCase()}${INJ_AB.slice(10)}`],
    ['inj1 with a one-character typo (bad checksum)', `${INJ_11.slice(0, -1)}${INJ_11.endsWith('q') ? 'p' : 'q'}`],
    ['another hrp (cosmos1)', COSMOS_11],
    ['32-byte contract address (inj1 + 58)', INJ_CONTRACT_32_BYTES],
    ['zero account (inj1)', INJ_ZERO],
    ['zero account (0x)', `0x${'0'.repeat(40)}`],
    ['0x without prefix', EVM_11.slice(2)],
    ['0x too short', EVM_11.slice(0, -2)],
    ['0x with non-hex', `0x${'g'.repeat(40)}`],
    ['inj1 truncated', INJ_11.slice(0, -1)],
    ['inj1 with a non-bech32 character (b)', `inj1b${INJ_11.slice(5)}`],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects %s with 400 INVALID_INJECTIVE_ADDRESS', (_label, input) => {
    expect(tryParsePayoutAddress(input)).toBeNull();
    expect(() => parsePayoutAddress(input)).toThrow(expect.objectContaining({ status: 400, message: 'INVALID_INJECTIVE_ADDRESS' }));
  });

  it('rejects non-strings', () => {
    for (const input of [undefined, null, 42, {}, ['inj1']]) expect(tryParsePayoutAddress(input)).toBeNull();
  });

  it('round-trips random accounts 0x <-> inj1 and always stores the 0029 CHECK shape', () => {
    for (let i = 0; i < 200; i++) {
      const evm = getAddress(`0x${randomBytes(20).toString('hex')}`);
      const fromEvm = parsePayoutAddress(evm);
      expect(fromEvm.evm).toBe(evm);
      expect(fromEvm.injective).toMatch(INJECTIVE_ACCOUNT_ADDRESS);
      expect(parsePayoutAddress(fromEvm.injective)).toEqual(fromEvm);
      expect(evmAddressOf(fromEvm.injective)).toBe(evm);
    }
  });
});

describe('evmAddressOf', () => {
  it('converts a stored inj1 account address and returns null for null or non-account values (legacy rows)', () => {
    expect(evmAddressOf(INJ_AB)).toBe(EVM_AB);
    expect(evmAddressOf(null)).toBeNull();
    expect(evmAddressOf(undefined)).toBeNull();
    expect(evmAddressOf('inj1notarealaddress')).toBeNull();
    expect(evmAddressOf(INJ_CONTRACT_32_BYTES)).toBeNull();
  });
});

describe('bech32ChecksumValid', () => {
  it('accepts valid lowercase bech32 of any hrp/length and rejects typos and junk', () => {
    expect(bech32ChecksumValid(INJ_11)).toBe(true);
    expect(bech32ChecksumValid(INJ_CONTRACT_32_BYTES)).toBe(true);
    expect(bech32ChecksumValid(COSMOS_11)).toBe(true);
    expect(bech32ChecksumValid(`${INJ_11.slice(0, -1)}p`)).toBe(false);
    expect(bech32ChecksumValid('inj1')).toBe(false);
    expect(bech32ChecksumValid('noseparator')).toBe(false);
    expect(bech32ChecksumValid('inj1bbbbbbbb')).toBe(false);
  });
});

describe('maskAddress', () => {
  it('keeps only the first 6 and last 4 characters', () => {
    expect(maskAddress(INJ_11)).toBe('inj1zy…qxqh');
    expect(maskAddress(INJ_11)).not.toContain(INJ_11.slice(6, -4));
    expect(maskAddress('short')).toBe('invalid');
  });
});
