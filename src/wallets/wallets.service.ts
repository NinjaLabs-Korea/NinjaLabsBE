import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';

/**
 * 지갑 연결 흐름 (온보딩 2단계)
 *
 * 1. POST /wallets/challenge  → nonce + 서명할 메시지 발급 (5분 만료, 1회용)
 * 2. 유저가 Keplr/Leap 등으로 메시지 서명
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

  async createChallenge(userId: string, address: string) {
    if (!address.startsWith('inj1')) {
      throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
    }
    const nonce = randomBytes(16).toString('hex');
    const message = [
      'NinjaLabs 지갑 소유권 인증',
      `주소: ${address}`,
      `nonce: ${nonce}`,
      '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.',
    ].join('\n');

    const r = await this.db.query(
      `INSERT INTO wallet_verification_challenge (user_id, wallet_address, nonce, message, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '5 minutes')
       RETURNING id, nonce, message, expires_at`,
      [userId, address, nonce, message],
    );
    return r.rows[0];
  }

  /**
   * ADR-36(signArbitrary) 서명 검증 → 지갑 연결 + NFT 민팅 잡 등록
   * FE는 challenge의 message를 Keplr/Leap signArbitrary로 서명해
   * {address, signature(base64), publicKey(base64)}를 보낸다.
   */
  async verifySignature(userId: string, address: string, signature: string, pubKey: string) {
    const challenge = await this.db.query<{ id: string; message: string }>(
      `SELECT id, message FROM wallet_verification_challenge
        WHERE user_id = $1 AND wallet_address = $2
          AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId, address],
    );
    if (!challenge.rowCount) throw new BadRequestException('CHALLENGE_EXPIRED');
    const { id: challengeId, message } = challenge.rows[0];

    if (!verifyAdr36Signature(address, message, pubKey, signature)) {
      throw new UnauthorizedException('INVALID_SIGNATURE');
    }

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
          [userId, address, pubKey],
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
