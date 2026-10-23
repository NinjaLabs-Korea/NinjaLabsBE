import { BadRequestException } from '@nestjs/common';
import { normalizeTxHash, TX_HASH } from './tx-hash';

describe('tx hash validation', () => {
  const hex = 'AbCdEf0123456789'.repeat(4);

  it('accepts 64 hex chars with or without 0x and normalizes to lowercase 0x-prefixed', () => {
    expect(normalizeTxHash(hex)).toBe(`0x${hex.toLowerCase()}`);
    expect(normalizeTxHash(`0x${hex}`)).toBe(`0x${hex.toLowerCase()}`);
    expect(normalizeTxHash(` ${hex} `)).toBe(`0x${hex.toLowerCase()}`);
    expect(TX_HASH.test(hex)).toBe(true);
  });

  it.each([
    '', '0x', hex.slice(0, 63), `${hex}0`, `0x${hex}0`, `0X${hex}`, `${hex.slice(0, 63)}g`, 'not a hash', `0x ${hex}`, 42, null, undefined,
  ])('rejects %p with 400 INVALID_TX_HASH', (value) => {
    const error = (() => { try { normalizeTxHash(value); return undefined; } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe('INVALID_TX_HASH');
  });
});
