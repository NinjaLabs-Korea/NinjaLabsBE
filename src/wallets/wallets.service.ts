import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { getInjectiveAddress, getEthereumAddress } from '@injectivelabs/sdk-ts';
import { getAddress, isAddress } from 'ethers';
import { randomBytes } from 'crypto';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { verifyEip191Signature } from '../common/crypto/eip191';
import { DatabaseService } from '../common/database/database.service';
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

  async createChallenge(userId: string, address: string) {
    const normalizedAddress = this.normalizeChallengeAddress(address);
    const nonce = randomBytes(16).toString('hex');
    const message = [
      'NinjaLabs 지갑 소유권 인증',
      `주소: ${normalizedAddress}`,
      `nonce: ${nonce}`,
      '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.',
    ].join('\n');

    const r = await this.db.query(
      `INSERT INTO wallet_verification_challenge (user_id, wallet_address, nonce, message, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
       RETURNING id, nonce, message, expires_at`,
      [userId, normalizedAddress, nonce, message],
    );
    return r.rows[0];
  }

  /**
   * 주소 형식에 따라 ADR-36(inj1) 또는 EIP-191(0x) 서명을 검증한다.
   * DB에는 두 방식 모두 CW-721 수신에 사용할 수 있는 inj1 주소로 저장한다.
   */
  async verifySignature(userId: string, address: string, signature: string, pubKey?: string) {
    const normalizedAddress = this.normalizeChallengeAddress(address);
    const isEvm = isAddress(address.trim());
    const challenge = await this.db.query<{ id: string; message: string }>(
      `SELECT id, message FROM wallet_verification_challenge
        WHERE user_id = $1 AND wallet_address = $2
          AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, normalizedAddress],
    );
    if (!challenge.rowCount) throw new BadRequestException('CHALLENGE_EXPIRED');
    const { id: challengeId, message } = challenge.rows[0];

    const valid = isEvm
      ? verifyEip191Signature(normalizedAddress, message, signature)
      : Boolean(pubKey) && verifyAdr36Signature(normalizedAddress, message, pubKey!, signature);
    if (!valid) {
      throw new UnauthorizedException('INVALID_SIGNATURE');
    }

    const injectiveAddress = isEvm
      ? getInjectiveAddress(normalizedAddress)
      : normalizedAddress;

    let walletId: string;
    try {
      walletId = await this.db.tx(async (tx) => {
        await tx.query(
          `UPDATE wallet_verification_challenge SET used_at = now() WHERE id = $1`,
          [challengeId],
        );
        const w = await tx.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, public_key, is_primary, verified_at)
           VALUES ($1, 'INJECTIVE', $2, $3, true, now())
           RETURNING id`,
          [userId, injectiveAddress, pubKey ?? null],
        );
        await tx.query(
          `UPDATE "user" SET onboarding_step = GREATEST(onboarding_step, 3)
            WHERE id = $1 AND deleted_at IS NULL`,
          [userId],
        );
        return w.rows[0].id;
      });
    } catch (err: unknown) {
      // 부분 유니크 인덱스 충돌: 주소가 이미 다른 계정에 연결됐거나 내 대표 지갑이 이미 있음
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('WALLET_ALREADY_LINKED');
      }
      throw err;
    }

    // 부모 NFT 민팅 잡 등록 (멱등 — 이미 있으면 no-op)
    await this.nfts.enqueueParentMint(userId, walletId);

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
