import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAddress } from 'ethers';
import { isProduction } from '../../common/bootstrap-checks';

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

/** REWARD_MULTISIG_ADDRESS 미설정 시 custody_address 자리표시값 — scripts/mainnet-preflight.sql이 이 값을 blocker로 찾는다 */
export const PENDING_MULTISIG_SETUP = 'PENDING_MULTISIG_SETUP';

/**
 * 멀티시그 주소 모양 — scripts/mainnet-preflight.sql의 custody 검사와 같은 집합:
 * bech32 `inj1` + 38자(계정, 20바이트) 또는 + 58자(컨트랙트 — cw3 멀티시그, 32바이트), 또는 EVM `0x` + 40 hex(Safe 등 — runbook §9).
 * bech32는 체크섬까지 확인한다 (한 글자 오타 = 스폰서가 엉뚱한 주소로 입금).
 */
const INJ_BECH32 = /^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}([qpzry9x8gf2tvdw0s3jn54khce6mua7l]{20})?$/;
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** BIP-173 bech32 체크섬 (소문자 주소만 — INJ_BECH32가 이미 소문자를 강제한다) */
function bech32ChecksumValid(address: string): boolean {
  const sep = address.lastIndexOf('1');
  const hrp = address.slice(0, sep);
  const data = [...address.slice(sep + 1)].map((c) => BECH32_CHARSET.indexOf(c));
  const values = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data];
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk === 1;
}

/** 멀티시그 주소로 쓸 수 없는 이유, 쓸 수 있으면 null (기동 로그용 — 값을 바꾸지는 않는다) */
export function rewardMultisigAddressProblem(value: string | undefined): string | null {
  const address = value?.trim();
  if (!address) return 'is not set';
  if (address.startsWith('0x')) return isAddress(address) ? null : 'is not a valid EVM address (0x + 40 hex, checksum casing)';
  if (!INJ_BECH32.test(address)) return 'is not shaped like an Injective address (inj1 + 38 chars for an account, + 58 for a contract) or an EVM 0x address';
  return bech32ChecksumValid(address) ? null : 'has an invalid bech32 checksum (typo?)';
}

/**
 * 바운티 보상 입력을 저장 가능한 토큰 메타데이터로 확정한다.
 *
 * - USDC는 운영자 입력 대신 env에 설정된 Injective EVM ERC-20 컨트랙트로 고정한다.
 * - 토큰 유형별 필수 메타데이터(denom / 컨트랙트 / 체인)를 검증한다.
 * 새 보상 토큰을 지원할 때는 이 클래스만 고친다.
 */
@Injectable()
export class RewardTokenResolver implements OnModuleInit {
  private readonly logger = new Logger(RewardTokenResolver.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * production 기동 시 REWARD_MULTISIG_ADDRESS 점검 — 미설정/빈 값/모양·체크섬 불일치면 **error 로그**(기동은 한다).
   * 기동 거부가 아닌 이유: runbook §1은 production 필수로 적지만 현재 운영(옛 main) Railway에 값이 있는지 확인되지 않았고,
   * 없을 때의 결과는 새 보상의 custody가 자리표시값이 되는 것(입금 불가 — 돈이 엉뚱한 곳으로 가지는 않는다)이라 크래시 루프보다 낫다.
   * 값은 그대로 쓴다 — 고치는 것은 운영자 몫 (scripts/mainnet-preflight.sql이 열린 보상의 잘못된 custody를 blocker로 잡는다).
   */
  onModuleInit(): void {
    if (!isProduction({ NODE_ENV: this.config.get<string>('NODE_ENV') })) return;
    const raw = this.config.get<string>('REWARD_MULTISIG_ADDRESS');
    const problem = rewardMultisigAddressProblem(raw);
    if (!problem) return;
    this.logger.error(
      `REWARD_MULTISIG_ADDRESS${raw?.trim() ? `=${JSON.stringify(raw)}` : ''} ${problem} — required in production. ` +
        (raw?.trim()
          ? 'New bounty rewards will show this address as the deposit address; fix the Railway variable before sponsors deposit (docs/runbook.md §1, §9).'
          : `New bounty rewards get custody_address ${PENDING_MULTISIG_SETUP} and sponsors have nowhere to deposit. Set it in the Railway dashboard (docs/runbook.md §1, §9).`),
    );
  }

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

  /** 스폰서 선입금을 받는 멀티시그 주소 (미설정·빈 값이면 자리표시값 — Railway 변수가 `''`로 남아도 빈 custody를 저장하지 않는다) */
  custodyAddress(): string {
    return this.config.get<string>('REWARD_MULTISIG_ADDRESS')?.trim() || PENDING_MULTISIG_SETUP;
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
