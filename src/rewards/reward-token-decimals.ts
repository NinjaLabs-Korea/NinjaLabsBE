/**
 * 보상 토큰의 소수 자릿수 (base unit → 표시 단위). DB(bounty_reward)는 토큰 메타데이터로 decimals 를 저장하지 않으므로
 * 서버가 아는 심볼만 여기서 확정한다 - FE `TOKEN_DECIMALS`(src/lib/api/codecs.ts)와 같은 값이어야 한다.
 * 새 보상 토큰을 지원할 때는 RewardTokenResolver 와 함께 이 표를 고친다. 모르는 심볼은 null (클라이언트가 표시를 건너뛴다).
 */
export const REWARD_TOKEN_DECIMALS: Readonly<Record<string, number>> = Object.freeze({ INJ: 18, USDC: 6 });

export function rewardTokenDecimals(symbol: string): number | null {
  const key = symbol.toUpperCase();
  return Object.hasOwn(REWARD_TOKEN_DECIMALS, key) ? REWARD_TOKEN_DECIMALS[key] : null;
}
