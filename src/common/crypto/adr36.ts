import { serializeSignDoc, StdSignDoc } from '@cosmjs/amino';
import { PrivateKey, PublicKey } from '@injectivelabs/sdk-ts';

/**
 * ADR-36 (signArbitrary) 서명 검증 — Injective 전용
 *
 * Keplr/Leap의 signArbitrary는 아래 형태의 StdSignDoc을 amino 규칙(키 정렬 + HTML escape)으로
 * 직렬화한 뒤 서명한다. Injective는 eth 계열 체인이라 해시는 sha256이 아닌 **keccak256**,
 * 주소 파생도 keccak(uncompressed pubkey)[12:] 방식 — 두 처리 모두 sdk-ts 헬퍼가 담당한다.
 */
export function buildAdr36SignDoc(signer: string, message: string): StdSignDoc {
  return {
    chain_id: '',
    account_number: '0',
    sequence: '0',
    fee: { gas: '0', amount: [] },
    msgs: [
      {
        type: 'sign/MsgSignData',
        value: {
          signer,
          data: Buffer.from(message, 'utf8').toString('base64'),
        },
      },
    ],
    memo: '',
  };
}

/**
 * @param address     서명자가 주장하는 inj1... 주소
 * @param message     서명 대상 원문 (challenge message)
 * @param publicKeyB64 압축 secp256k1 공개키 (base64 — Keplr signArbitrary 응답의 pub_key.value)
 * @param signatureB64 64바이트 r||s 서명 (base64 — 응답의 signature)
 * @returns 공개키가 주소와 일치하고 서명이 유효하면 true
 */
export function verifyAdr36Signature(
  address: string,
  message: string,
  publicKeyB64: string,
  signatureB64: string,
): boolean {
  try {
    // 1) 공개키 → 주소 파생이 주장된 주소와 일치해야 함 (남의 키로 서명 제출 방지)
    const pubKey = PublicKey.fromBase64(publicKeyB64);
    if (pubKey.toAddress().toBech32() !== address) return false;

    // 2) ADR-36 sign doc 재구성 → keccak256 → secp256k1 검증
    const signDocBytes = serializeSignDoc(buildAdr36SignDoc(address, message));
    const signatureHex = Buffer.from(signatureB64, 'base64').toString('hex');
    return PrivateKey.verifyArbitrarySignature({
      signature: signatureHex,
      signDoc: signDocBytes,
      publicKey: pubKey.toHex(),
    });
  } catch {
    return false; // 잘못된 인코딩/키 길이 등은 전부 "검증 실패"로 취급
  }
}
