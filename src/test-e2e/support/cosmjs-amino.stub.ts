/** `@cosmjs/amino` 대역 (ESM 의존성 때문에 jest가 못 불러온다) - ADR-36 경로 전용이며 e2e는 EVM(EIP-191) 서명만 쓴다 */
export type StdSignDoc = Record<string, unknown>;
export function serializeSignDoc(): never {
  throw new Error('@cosmjs/amino is not available in the e2e suite (ADR-36 signing is out of scope; EIP-191 is exercised)');
}
