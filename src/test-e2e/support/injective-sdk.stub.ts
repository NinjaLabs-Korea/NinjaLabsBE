/**
 * `@injectivelabs/sdk-ts` 대역 — jest.e2e.config.js의 moduleNameMapper가 이 파일로 바꾼다.
 *
 * sdk-ts(와 그 의존성 @scure/@noble)는 ESM 전용이라 jest(CommonJS)가 불러오지 못한다. 앱이 HTTP 경로에서 쓰는 것은
 * 주소 변환 두 개뿐이므로(wallets.service.ts) 그 둘을 **실제 bech32 구현**으로 제공한다 — 결과는 sdk-ts와 바이트 단위로 같다
 * (inj1… = bech32('inj', 20바이트 EVM 주소)). 온체인 클래스(PrivateKey, MsgBroadcasterWithPk, ChainGrpcWasmApi …)는
 * 호출되면 실패한다: 체인 I/O는 harness가 InjectiveNftClient를 가짜로 바꿔 끊고, ADR-36(Keplr) 서명 경로는 e2e 범위 밖이다.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const value of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  else if (!pad && (bits >= from || ((acc << (to - bits)) & maxv))) throw new Error('invalid bech32 padding');
  return out;
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words = convertBits([...bytes], 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join('')}`;
}

function bech32Decode(address: string): { hrp: string; bytes: Uint8Array } {
  const lower = address.toLowerCase();
  if (lower !== address && address.toUpperCase() !== address) throw new Error('mixed-case bech32');
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) throw new Error('invalid bech32');
  const hrp = lower.slice(0, sep);
  const data = [...lower.slice(sep + 1)].map((c) => {
    const index = CHARSET.indexOf(c);
    if (index < 0) throw new Error('invalid bech32 character');
    return index;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error('invalid bech32 checksum');
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

export function getInjectiveAddress(ethAddress: string): string {
  const hex = ethAddress.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`Invalid Ethereum address: ${ethAddress}`);
  return bech32Encode('inj', Uint8Array.from(Buffer.from(hex, 'hex')));
}

export function getEthereumAddress(injectiveAddress: string): string {
  if (injectiveAddress.startsWith('0x')) return injectiveAddress;
  const { hrp, bytes } = bech32Decode(injectiveAddress);
  if (hrp !== 'inj' || bytes.length !== 20) throw new Error(`Invalid Injective address: ${injectiveAddress}`);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function unavailable(name: string): never {
  throw new Error(`@injectivelabs/sdk-ts ${name} is not available in the e2e suite (chain I/O is faked)`);
}

export class PrivateKey {
  static fromMnemonic(): never { return unavailable('PrivateKey'); }
  static fromHex(): never { return unavailable('PrivateKey'); }
}
export class PublicKey {
  static fromBase64(): never { return unavailable('PublicKey'); }
  static fromHex(): never { return unavailable('PublicKey'); }
}
export class MsgBroadcasterWithPk { constructor() { unavailable('MsgBroadcasterWithPk'); } }
export class ChainGrpcWasmApi { constructor() { unavailable('ChainGrpcWasmApi'); } }
export class MsgExecuteContract { static fromJSON(): never { return unavailable('MsgExecuteContract'); } }
