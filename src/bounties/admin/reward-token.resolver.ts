import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type RewardInput = {
  tokenType: string;
  tokenDenom?: string;
  tokenContractAddress?: string;
  evmChainId?: number;
  displaySymbol: string;
  amount: string;
};

/** Injective EVM 메인넷(1776) / 테스트넷(1439) */
const INJECTIVE_EVM_CHAIN_IDS = [1439, 1776];

/**
 * 바운티 보상 입력을 저장 가능한 토큰 메타데이터로 확정한다.
 *
 * - USDC는 운영자 입력 대신 env에 설정된 Injective EVM ERC-20 컨트랙트로 고정한다.
 * - 토큰 유형별 필수 메타데이터(denom / 컨트랙트 / 체인)를 검증한다.
 * 새 보상 토큰을 지원할 때는 이 클래스만 고친다.
 */
@Injectable()
export class RewardTokenResolver {
  constructor(private readonly config: ConfigService) {}

  resolve(input: RewardInput | undefined): RewardInput | undefined {
    if (!input) return undefined;
    const reward = input.displaySymbol.toUpperCase() === 'USDC' ? this.usdc(input) : input;

    if (reward.tokenType === 'NATIVE' && !reward.tokenDenom) {
      throw new BadRequestException('REWARD_TOKEN_DENOM_REQUIRED');
    }
    if (reward.tokenType === 'CW20' && !reward.tokenContractAddress) {
      throw new BadRequestException('REWARD_TOKEN_CONTRACT_REQUIRED');
    }
    if (reward.tokenType === 'ERC20' && (!reward.tokenContractAddress || !reward.evmChainId)) {
      throw new BadRequestException('REWARD_EVM_METADATA_REQUIRED');
    }
    return reward;
  }

  /** 스폰서 선입금을 받는 멀티시그 주소 (미설정이면 자리표시값) */
  custodyAddress(): string {
    return this.config.get<string>('REWARD_MULTISIG_ADDRESS') ?? 'PENDING_MULTISIG_SETUP';
  }

  private usdc(input: RewardInput): RewardInput {
    const contract = this.config.get<string>('USDC_EVM_CONTRACT_ADDRESS');
    const chainId = Number(this.config.get<string>('INJECTIVE_EVM_CHAIN_ID'));
    if (!contract || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
      throw new BadRequestException('USDC_EVM_CONTRACT_NOT_CONFIGURED');
    }
    if (!INJECTIVE_EVM_CHAIN_IDS.includes(chainId)) {
      throw new BadRequestException('INJECTIVE_EVM_CHAIN_NOT_CONFIGURED');
    }
    return {
      ...input,
      tokenType: 'ERC20',
      tokenDenom: `erc20:${contract.toLowerCase()}`,
      tokenContractAddress: contract,
      evmChainId: chainId,
    };
  }
}
