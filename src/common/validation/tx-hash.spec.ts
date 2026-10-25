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

  // scripts/record-refund.js는 src를 import할 수 없어 같은 규칙의 사본을 갖는다 — 어긋나면 환불 증빙 해시가 입금/지급 해시와 다른 모양으로 저장돼 상호 배제 검사를 빠져나간다
  it('matches the copy in scripts/record-refund.js (null instead of throwing)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const script = require('../../../scripts/record-refund') as { normalizeTxHash: (raw: unknown) => string | null };
    const samples: unknown[] = [
      hex, `0x${hex}`, ` ${hex} `, '', '0x', hex.slice(0, 63), `${hex}0`, `0x${hex}0`, `0X${hex}`, `${hex.slice(0, 63)}g`, `0x ${hex}`, 42, null, undefined,
    ];
    for (const sample of samples) {
      let expected: string | null;
      try { expected = normalizeTxHash(sample); } catch { expected = null; }
      expect(script.normalizeTxHash(sample)).toBe(expected);
    }
  });
});
