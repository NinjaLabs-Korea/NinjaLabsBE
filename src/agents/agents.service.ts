import {
  ConflictException,
  Injectable,
  NotImplementedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DatabaseService } from '../common/database/database.service';

/**
 * AI 에이전트 등록 (ERD §12, 기획 PART 2-4)
 *
 * 등록 검증: 유저가 "내 에이전트"임을 지갑 서명으로 증명
 *   1. 유저가 에이전트의 public_key + wallet_address 제출
 *   2. 주인 지갑 private key로 서명 → 서버가 public key로 검증
 *   3. 검증 성공 → agent ACTIVE + API key 발급 (원문 1회 노출, DB엔 해시만)
 */
@Injectable()
export class AgentsService {
  constructor(private readonly db: DatabaseService) {}

  async register(ownerUserId: string, name: string, description: string | undefined, publicKey: string, walletAddress: string) {
    try {
      const r = await this.db.query<{ id: string }>(
        `INSERT INTO agent (owner_user_id, name, description, public_key, wallet_address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [ownerUserId, name, description ?? null, publicKey, walletAddress],
      );
      return { agentId: r.rows[0].id, status: 'PENDING_VERIFICATION' };
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
      }
      throw err;
    }
  }

  /**
   * TODO(구현): 주인 지갑 서명 검증 → ACTIVE 전환 → API key 발급
   * 검증 성공 시에만 API key를 반환한다 (원문은 이 응답 1회뿐).
   */
  async verifyAndIssueKey(_ownerUserId: string, _agentId: string, _signature: string) {
    throw new NotImplementedException(
      'TODO: verify owner wallet signature, set agent ACTIVE, then issue API key',
    );
  }

  /** API key 생성 헬퍼 — nj_ 프리픽스 + 랜덤, DB엔 sha256 해시만 */
  protected generateApiKey() {
    const raw = `nj_${randomBytes(32).toString('base64url')}`;
    return {
      raw,
      prefix: raw.slice(0, 11),
      hash: createHash('sha256').update(raw).digest('hex'),
    };
  }

  /** 내 에이전트 목록 */
  async myAgents(ownerUserId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address, a.verified_at,
              k.key_prefix, k.status AS key_status, k.expires_at AS key_expires_at
         FROM agent a
         LEFT JOIN agent_api_key k ON k.agent_id = a.id AND k.status = 'ACTIVE'
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at`,
      [ownerUserId],
    );
    return r.rows;
  }
}
