import { verifyAdr36Signature } from './adr36';
import { recoverEip191PublicKey } from './eip191';

export type WalletSignatureInput = {
  /** 서명자가 주장하는 주소 (정규화된 0x... 또는 inj1...) */
  address: string;
  message: string;
  signature: string;
  /** ADR-36은 필수 (지갑 응답의 pub_key.value), EIP-191은 서명에서 복원하므로 불필요 */
  publicKey?: string | null;
};

/**
 * 지갑 종류별 서명 방식.
 * 지갑/에이전트 서비스는 이 인터페이스만 사용하고, 새 지갑 종류는 구현체를 추가해 지원한다.
 */
export interface WalletSignatureScheme {
  readonly kind: 'EVM' | 'INJECTIVE';
  /** 유효하면 서명자의 압축 공개키(모르면 null)를 담아 반환, 무효면 null */
  verify(input: WalletSignatureInput): { publicKey: string | null } | null;
}

/** EVM 지갑 (MetaMask 등) — EIP-191 personal_sign */
const eip191Scheme: WalletSignatureScheme = {
  kind: 'EVM',
  verify: ({ address, message, signature }) => {
    const publicKey = recoverEip191PublicKey(address, message, signature);
    return publicKey ? { publicKey } : null;
  },
};

/** Cosmos 지갑 (Keplr/Leap) — ADR-36 signArbitrary */
const adr36Scheme: WalletSignatureScheme = {
  kind: 'INJECTIVE',
  verify: ({ address, message, signature, publicKey }) =>
    publicKey && verifyAdr36Signature(address, message, publicKey, signature)
      ? { publicKey }
      : null,
};

export function isEvmAddress(address: string): boolean {
  return /^0x/i.test(address.trim());
}

/** 주소 형식으로 서명 방식을 고른다 (0x… → EIP-191, 그 외 → ADR-36) */
export function signatureSchemeFor(address: string): WalletSignatureScheme {
  return isEvmAddress(address) ? eip191Scheme : adr36Scheme;
}
