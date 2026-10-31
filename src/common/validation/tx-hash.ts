import { BadRequestException } from '@nestjs/common';

/**
 * 온체인 tx 해시 - EVM과 Injective(Tendermint) 모두 32바이트 hex다. `0x` 접두사는 선택.
 * 저장 전에는 항상 소문자 + `0x` 접두사로 정규화해 uq_bounty_reward_deposit_tx(0014)와 markPaid의 재사용 조회가
 * 같은 해시의 대소문자·접두사 변형을 하나로 본다.
 */
export const TX_HASH = /^(0x)?[0-9a-fA-F]{64}$/;

/** 형식이 틀리면 400 INVALID_TX_HASH, 맞으면 `0x` + 소문자 64자리 */
export function normalizeTxHash(raw: unknown): string {
  if (typeof raw !== 'string' || !TX_HASH.test(raw.trim())) {
    throw new BadRequestException('INVALID_TX_HASH');
  }
  const hex = raw.trim().replace(/^0x/i, '').toLowerCase();
  return `0x${hex}`;
}
