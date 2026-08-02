import {
  BadRequestException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

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
  constructor(private readonly db: DatabaseService) {}

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
   * TODO(구현): Injective(secp256k1 / ADR-36) 서명 검증
   *  - @injectivelabs/sdk-ts 의 verifyArbitrary 계열 사용
   *  - 검증 성공 시: challenge.used_at 기록 → wallet upsert → nft_job(MINT_PARENT) 등록
   */
  async verifySignature(_userId: string, _address: string, _signature: string, _pubKey: string) {
    throw new NotImplementedException(
      'TODO: verify ADR-36 signature with @injectivelabs/sdk-ts, then upsert wallet + enqueue MINT_PARENT job',
    );
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
