import { BadRequestException } from '@nestjs/common';
import { getAddress } from 'ethers';

/**
 * Injective 계정 주소(지급 주소) 검증·변환 - 순수 TS (bech32 BIP-173 + ethers.getAddress). `@injectivelabs/sdk-ts`(ESM 전용)를 쓰지 않는다.
 *
 * 같은 20바이트 계정을 두 표기로 쓴다:
 *   - `inj1...` bech32 (hrp `inj`, 데이터 32자 + 체크섬 6자 = 38자): bank send(NATIVE inj), CW20 송금 대상
 *   - `0x...` EVM 20바이트 (EIP-55 체크섬 표기): Injective EVM ERC20(USDC) 송금 대상
 * 저장은 소문자 inj1 하나로 한다(0029 `chk_submission_payout_address`, `chk_payout_recipient_address`와 같은 모양). 0x 표기는 계산해서 내보낸다.
 *
 * 받는 입력 (parsePayoutAddress):
 *   - 0x + 40 hex. 대소문자가 섞였으면 EIP-55 체크섬이 맞아야 한다(전부 소문자/전부 대문자는 체크섬이 없는 표기라 받는다)
 *   - inj1 + 38자 bech32 소문자, 또는 전부 대문자(BIP-173이 허용하는 표기 - 소문자로 접는다). 대소문자 혼합은 BIP-173상 무효라 거부
 * 거부: 다른 hrp(`cosmos1` 등), 32바이트 컨트랙트 주소(inj1 + 58자), 체크섬 불일치, 0 주소(받는 사람이 없다), 앞뒤 공백 밖의 공백.
 * 모두 400 `INVALID_INJECTIVE_ADDRESS` 하나로 알린다 (어느 규칙에 걸렸는지는 FE 문구가 구분하지 않는다).
 */

export const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const INJECTIVE_HRP = 'inj';
/** 저장 모양 - 0029 CHECK와 같은 정규식 */
export const INJECTIVE_ACCOUNT_ADDRESS = /^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/;
const EVM_ADDRESS_INPUT = /^0x[0-9a-fA-F]{40}$/;
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  return [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
}

/**
 * BIP-173 bech32 체크섬 (소문자 주소만 - 호출자가 문자 집합과 소문자를 먼저 확인한다).
 * 멀티시그 주소 점검(bounties/admin/reward-token.resolver.ts)과 지급 주소 검증이 같이 쓴다.
 */
export function bech32ChecksumValid(address: string): boolean {
  const sep = address.lastIndexOf('1');
  if (sep < 1) return false;
  const hrp = address.slice(0, sep);
  const data = [...address.slice(sep + 1)].map((c) => BECH32_CHARSET.indexOf(c));
  if (data.length < 6 || data.some((v) => v < 0)) return false;
  return bech32Polymod([...hrpExpand(hrp), ...data]) === 1;
}

/** 비트 묶음 변환 (BIP-173 convertbits). pad=false면 남는 비트가 0이 아니거나 from 단위 이상 남을 때 null */
function convertBits(data: readonly number[], from: number, to: number, pad: boolean): number[] | null {
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
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null;
  }
  return out;
}

function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const data = convertBits([...bytes], 8, 5, true) as number[];
  const polymod = bech32Polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (polymod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('')}`;
}

/** 소문자 inj1 계정 주소 → 20바이트. 모양·체크섬·길이가 틀리면 null */
function injectiveAccountBytes(address: string): Uint8Array | null {
  if (!INJECTIVE_ACCOUNT_ADDRESS.test(address) || !bech32ChecksumValid(address)) return null;
  const data = [...address.slice(INJECTIVE_HRP.length + 1, -6)].map((c) => BECH32_CHARSET.indexOf(c));
  const bytes = convertBits(data, 5, 8, false);
  return bytes && bytes.length === 20 ? Uint8Array.from(bytes) : null;
}

function hexOf(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function isZero(bytes: Uint8Array): boolean {
  return bytes.every((b) => b === 0);
}

export type PayoutAddress = {
  /** 저장 표기: 소문자 inj1 */
  injective: string;
  /** 같은 바이트의 EIP-55 0x 표기 */
  evm: string;
};

/** 입력을 확인해 두 표기로 돌려준다. 받을 수 없는 입력이면 null (규칙은 파일 머리 주석) */
export function tryParsePayoutAddress(input: unknown): PayoutAddress | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  let bytes: Uint8Array | null = null;
  if (value.startsWith('0x')) {
    if (!EVM_ADDRESS_INPUT.test(value)) return null;
    let checksummed: string;
    try { checksummed = getAddress(value); } catch { return null; } // 대소문자 혼합인데 EIP-55가 틀림
    bytes = Uint8Array.from(Buffer.from(checksummed.slice(2), 'hex'));
  } else {
    // BIP-173: 전부 소문자 또는 전부 대문자만 유효. 대문자는 소문자로 접는다
    const folded = value === value.toUpperCase() ? value.toLowerCase() : value;
    if (folded !== folded.toLowerCase()) return null;
    bytes = injectiveAccountBytes(folded);
  }
  if (!bytes || isZero(bytes)) return null;
  return { injective: bech32Encode(INJECTIVE_HRP, bytes), evm: getAddress(hexOf(bytes)) };
}

/** tryParsePayoutAddress + 400 INVALID_INJECTIVE_ADDRESS */
export function parsePayoutAddress(input: unknown): PayoutAddress {
  const parsed = tryParsePayoutAddress(input);
  if (!parsed) throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
  return parsed;
}

/**
 * 저장된 소문자 inj1 계정 주소의 EIP-55 0x 표기. null이거나 계정 주소 모양이 아니면(레거시 wallet 행 등) null - 읽기 모델에서 쓴다(던지지 않는다).
 */
export function evmAddressOf(injectiveAddress: string | null | undefined): string | null {
  if (!injectiveAddress) return null;
  const bytes = injectiveAccountBytes(injectiveAddress);
  return bytes ? getAddress(hexOf(bytes)) : null;
}

/**
 * 감사·로그용 마스킹 - 앞 6자 + `…` + 뒤 4자. 짧은 값은 'invalid'. 원문 주소는 감사 행과 로그에 남기지 않는다.
 * (common/logging/onboarding-log.ts의 maskAddress가 이 함수를 다시 내보낸다)
 */
export function maskAddress(address: string): string {
  const value = address.trim();
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'invalid';
}
