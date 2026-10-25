/**
 * 압축 secp256k1 공개키(base64)의 정규 표기 — Node의 base64 디코더는 알파벳 밖 문자·공백·패딩 유무를 조용히 무시하므로
 * `AAA…=`, `AAA…`(패딩 없음), `AAA…!!!!…`가 같은 33바이트 키로 읽힌다. 검증을 통과한 클라이언트 문자열을 그대로 저장하면
 * 같은 키가 서로 다른 문자열로 남아 유니크 인덱스(`uq_agent_public_key`)가 중복을 못 잡고, 요청 본문 상한(100 KB)까지 TEXT 컬럼을 채울 수 있다.
 * 검증이 끝난 키를 저장하기 전에 이 함수로 다시 인코딩한다 (33바이트가 아니면 null).
 */
export function canonicalPublicKeyBase64(publicKeyB64: string): string | null {
  const key = Buffer.from(publicKeyB64, 'base64');
  return key.length === 33 ? key.toString('base64') : null;
}
