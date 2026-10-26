import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { getInjectiveAddress, getEthereumAddress } from '@injectivelabs/sdk-ts';
import { getAddress } from 'ethers';
import { randomBytes } from 'crypto';
import { isEvmAddress, signatureSchemeFor } from '../common/crypto/wallet-signature';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { NftsService } from '../nfts/nfts.service';

/**
 * 지갑 연결 흐름 (온보딩 2단계)
 *
 * 1. POST /wallets/challenge  → nonce + 서명할 메시지 발급 (5분 만료, 1회용)
 * 2. 유저가 Keplr/Leap(ADR-36) 또는 EVM 지갑(EIP-191)으로 메시지 서명
 * 3. POST /wallets/verify     → 서명 검증 → wallet 저장 → NFT 민팅 잡 등록
 *
 * 원칙: 검증 실패/스킵해도 가입·온보딩은 진행 (기획 확정 사항)
 */
@Injectable()
export class WalletsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nfts: NftsService,
  ) {}

  private normalizeChallengeAddress(address: string): string {
    const trimmed = address.trim();
    if (/^0x/i.test(trimmed)) {
      try {
        return getAddress(trimmed);
      } catch {
        throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
      }
    }

    if (!trimmed.startsWith('inj1')) {
      throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
    }

    try {
      // decode + re-encode so an invalid or non-Injective bech32 address is rejected.
      return getInjectiveAddress(getEthereumAddress(trimmed));
    } catch {
      throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
    }
  }

  /** 에이전트 지갑(0x 또는 inj1로 저장)이 이 inj1 주소와 같은 계정인가 */
  private sameAccount(agentWallet: string, injectiveAddress: string): boolean {
    try {
      const inj = isEvmAddress(agentWallet) ? getInjectiveAddress(agentWallet) : agentWallet;
      return inj.toLowerCase() === injectiveAddress.toLowerCase();
    } catch {
      return false;
    }
  }

  async createChallenge(userId: string, address: string) {
    const normalizedAddress = this.normalizeChallengeAddress(address);
    const nonce = randomBytes(16).toString('hex');
    // 사용자가 지갑 서명창에서 직접 읽는 문장이라 영어·한국어·중국어를 함께 싣는다 (로케일을 모르는 BE가 한 언어만 고를 수 없다).
    // 서명 검증은 DB에 저장된 이 문자열 그대로 하므로 문구를 바꿔도 이미 발급된 challenge에는 영향이 없다
    const message = [
      'NinjaLabs wallet ownership verification / NinjaLabs 지갑 소유권 인증 / NinjaLabs 钱包所有权验证',
      `Address / 주소 / 地址: ${normalizedAddress}`,
      `nonce: ${nonce}`,
      'This signature does not send a transaction and costs no gas.',
      '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.',
      '此签名不会发起交易，也不会产生 gas 费用。',
    ].join('\n');

    // 같은 (user, wallet)의 미사용 challenge는 지우고 새로 발급 — 열린 challenge는 항상 최대 1개 (만료 행 정리는 MaintenanceService 크론).
    // 같은 (user, wallet)의 동시 발급은 트랜잭션 범위 advisory lock으로 직렬화한다 — 두 요청이 서로의 DELETE를 보지 못한 채 INSERT하면 2개가 열린다
    return this.db.tx(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1::text || ':' || $2::text))`,
        [userId, normalizedAddress],
      );
      await tx.query(
        `DELETE FROM wallet_verification_challenge
          WHERE user_id = $1 AND wallet_address = $2 AND used_at IS NULL`,
        [userId, normalizedAddress],
      );
      const r = await tx.query<{ id: string; nonce: string; message: string; expires_at: string }>(
        `INSERT INTO wallet_verification_challenge (user_id, wallet_address, nonce, message, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
         RETURNING id, nonce, message, expires_at`,
        [userId, normalizedAddress, nonce, message],
      );
      return r.rows[0];
    });
  }

  /**
   * 주소 형식에 따라 ADR-36(inj1) 또는 EIP-191(0x) 서명을 검증한다.
   * DB에는 두 방식 모두 CW-721 수신에 사용할 수 있는 inj1 주소로 저장한다.
   */
  async verifySignature(userId: string, address: string, signature: string, pubKey?: string) {
    const normalizedAddress = this.normalizeChallengeAddress(address);
    // 두 서명 방식 모두 CW-721 수신에 쓰는 inj1 주소로 저장한다
    const injectiveAddress = isEvmAddress(normalizedAddress)
      ? getInjectiveAddress(normalizedAddress)
      : normalizedAddress;

    try {
      // challenge 조회(행 잠금) → 서명 검증 → 소비(조건부 UPDATE) → 지갑 저장을 한 트랜잭션에서.
      // 같은 challenge로 동시에 두 번 verify하면 잠금 뒤 두 번째는 used_at이 찍힌 행을 보고 CHALLENGE_EXPIRED로 끝난다 (지갑은 1개만 저장).
      await this.db.tx(async (tx) => {
        // 유효한(미사용·미만료) 최신 challenge를 우선 고르고, 없으면 최신 무효 행으로 "없음"과 "만료/사용됨"을 구분한다
        const challenge = await tx.query<{ id: string; message: string; valid: boolean }>(
          `SELECT id, message, (used_at IS NULL AND expires_at > now()) AS valid
             FROM wallet_verification_challenge
            WHERE user_id = $1 AND wallet_address = $2
            ORDER BY valid DESC, created_at DESC
            LIMIT 1
              FOR UPDATE`,
          [userId, normalizedAddress],
        );
        if (!challenge.rowCount) throw new BadRequestException('CHALLENGE_NOT_FOUND');
        if (!challenge.rows[0].valid) throw new BadRequestException('CHALLENGE_EXPIRED');
        const { id: challengeId, message } = challenge.rows[0];

        const verified = signatureSchemeFor(normalizedAddress).verify({ address: normalizedAddress, message, signature, publicKey: pubKey });
        if (!verified) {
          throw new UnauthorizedException('INVALID_SIGNATURE');
        }

        // 소비는 조건부 UPDATE로 — 조회와 소비 사이에 만료됐거나(경계) 이미 쓰였으면 0행 → 400 CHALLENGE_EXPIRED
        const consumed = await tx.query(
          `UPDATE wallet_verification_challenge SET used_at = now()
            WHERE id = $1 AND used_at IS NULL AND expires_at > now()
            RETURNING id`,
          [challengeId],
        );
        if (!consumed.rowCount) throw new BadRequestException('CHALLENGE_EXPIRED');
        // 내 (폐기·삭제되지 않은) 에이전트의 지갑을 내 대표 지갑으로 묶을 수 없다: 에이전트 등록의 AGENT_WALLET_IS_OWNER_WALLET 규칙의 반대 방향
        // (보상은 소유자 지갑으로 나가므로 같은 주소면 소유자와 에이전트가 구분되지 않는다). 던지면 위의 challenge 소비도 롤백된다
        const agents = await tx.query<{ wallet_address: string }>(
          `SELECT wallet_address FROM agent WHERE owner_user_id = $1 AND status <> 'REVOKED' AND deleted_at IS NULL`,
          [userId],
        );
        if (agents.rows.some((row) => this.sameAccount(row.wallet_address, injectiveAddress))) {
          throw new BadRequestException('AGENT_WALLET_IS_OWNER_WALLET');
        }
        const w = await tx.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, public_key, is_primary, verified_at)
           VALUES ($1, 'INJECTIVE', $2, $3, true, now())
           RETURNING id`,
          // 검증된 키만 저장한다 — EIP-191은 서명에서 복원한 키, ADR-36은 주소와 대조된 키. 클라이언트가 덧붙인 publicKey를 그대로 믿지 않는다
          [userId, injectiveAddress, verified.publicKey],
        );
        const stepped = await tx.query(
          `UPDATE "user" SET onboarding_step = GREATEST(onboarding_step, 3)
            WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );
        // 동시 탈퇴(유저 행을 먼저 잠그고 지갑을 해제한다)가 커밋됐으면 0행이다 — 이 UPDATE가 탈퇴 커밋을 기다렸다 재평가하기 때문에 위의 지갑 INSERT를
        // 되돌릴 수 있다. 그냥 두면 탈퇴한 유저의 연결된 지갑이 남아 그 주소가 부분 유니크 인덱스를 영구히 점유한다
        if (!stepped.rowCount) throw new NotFoundException('USER_NOT_FOUND');
        // 부모 NFT 민팅 잡을 지갑 저장과 같은 트랜잭션에서 등록 (멱등) — 커밋 뒤 크래시로 잡만 빠지는 일이 없다
        await this.nfts.enqueueParentMintInTransaction(tx, userId, w.rows[0].id);
      });
    } catch (err: unknown) {
      // 부분 유니크 인덱스 충돌: 주소가 이미 다른 계정에 연결됐거나 내 대표 지갑이 이미 있음
      if (isUniqueViolation(err)) {
        // 이미 내 대표 지갑이 바로 이 주소면 충돌이 아니라 재시도다 — 첫 verify가 커밋됐는데 응답이 유실된 경우(서명은 위에서 방금 검증됐다).
        // 409로 답하면 온보딩이 이미 끝난 일을 실패로 보여 준다. 이 트랜잭션은 롤백됐지만 지갑·단계·민팅 잡은 첫 호출이 이미 남겼다
        const mine = await this.myWallet(userId);
        if (mine?.address === injectiveAddress) return mine;
        throw new ConflictException('WALLET_ALREADY_LINKED');
      }
      throw err;
    }

    return this.myWallet(userId);
  }

  async myWallet(userId: string) {
    const r = await this.db.query(
      `SELECT id, chain, address, verified_at, created_at
         FROM wallet
        WHERE user_id = $1 AND is_primary = true AND disconnected_at IS NULL`,
      [userId],
    );
    return r.rows[0] ?? null;
  }
}
