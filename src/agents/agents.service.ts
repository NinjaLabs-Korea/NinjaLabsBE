import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { getAddress, isAddress } from 'ethers';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { recoverEip191PublicKey } from '../common/crypto/eip191';
import { DatabaseService } from '../common/database/database.service';
import { agentApiKeyPrefix, hashAgentApiKey } from './agent-api-key';

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

  async register(
    ownerUserId: string,
    name: string,
    description: string | undefined,
    publicKey: string | undefined,
    walletAddress: string,
  ) {
    const isEvm = walletAddress.trim().startsWith('0x');
    if (isEvm && !isAddress(walletAddress.trim())) {
      throw new BadRequestException('INVALID_AGENT_WALLET_ADDRESS');
    }
    if (!isEvm && (!walletAddress.trim().startsWith('inj1') || !publicKey)) {
      throw new BadRequestException('AGENT_PUBLIC_KEY_REQUIRED');
    }
    const normalizedAddress = isEvm ? getAddress(walletAddress.trim()) : walletAddress.trim();

    try {
      const r = await this.db.query<{ id: string }>(
        `INSERT INTO agent (owner_user_id, name, description, public_key, wallet_address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [ownerUserId, name, description ?? null, publicKey ?? null, normalizedAddress],
      );
      return {
        agentId: r.rows[0].id,
        status: 'PENDING_VERIFICATION',
        // 에이전트 지갑 키로 이 메시지를 ADR-36 서명해 /agents/:id/verify로 제출
        verificationMessage: AgentsService.verificationMessage(r.rows[0].id, ownerUserId),
      };
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        const pending = await this.db.query<{ id: string }>(
          `SELECT id FROM agent
            WHERE owner_user_id = $1 AND wallet_address = $2
              AND status = 'PENDING_VERIFICATION' AND deleted_at IS NULL`,
          [ownerUserId, normalizedAddress],
        );
        if (pending.rowCount) {
          return {
            agentId: pending.rows[0].id,
            status: 'PENDING_VERIFICATION',
            verificationMessage: AgentsService.verificationMessage(
              pending.rows[0].id,
              ownerUserId,
            ),
          };
        }
        throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
      }
      throw err;
    }
  }

  /**
   * 소유 증명 메시지 — agentId + 소유 유저에 결정론적으로 바인딩되어
   * 다른 에이전트/유저로의 서명 재사용이 불가능하다.
   */
  static verificationMessage(agentId: string, ownerUserId: string): string {
    return [
      'NinjaLabs AI 에이전트 등록 검증',
      `agentId: ${agentId}`,
      `owner: ${ownerUserId}`,
      '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.',
    ].join('\n');
  }

  /**
   * 에이전트 지갑 서명 검증 → ACTIVE 전환 → API key 발급
   * 등록 시 저장한 public_key로 검증하므로 서명 주체 = 에이전트 지갑 키 소유자.
   * 검증 성공 시에만 API key를 반환한다 (원문은 이 응답 1회뿐).
   */
  async verifyAndIssueKey(ownerUserId: string, agentId: string, signature: string) {
    const r = await this.db.query<{
      status: string;
      public_key: string | null;
      wallet_address: string;
    }>(
      `SELECT status, public_key, wallet_address FROM agent
        WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [agentId, ownerUserId],
    );
    if (!r.rowCount) throw new NotFoundException('AGENT_NOT_FOUND');
    const agent = r.rows[0];
    if (agent.status !== 'PENDING_VERIFICATION') {
      throw new ConflictException('AGENT_ALREADY_VERIFIED');
    }

    const message = AgentsService.verificationMessage(agentId, ownerUserId);
    const isEvm = agent.wallet_address.startsWith('0x');
    const recoveredPublicKey = isEvm
      ? recoverEip191PublicKey(agent.wallet_address, message, signature)
      : null;
    const verified = isEvm
      ? recoveredPublicKey !== null
      : Boolean(agent.public_key) &&
        verifyAdr36Signature(agent.wallet_address, message, agent.public_key!, signature);
    if (!verified) {
      throw new UnauthorizedException('INVALID_SIGNATURE');
    }

    const key = this.generateApiKey();
    const expires = await this.db.tx(async (tx) => {
      await tx.query(
        `UPDATE agent
            SET status = 'ACTIVE', verified_at = now(), public_key = COALESCE($2, public_key)
          WHERE id = $1`,
        [agentId, recoveredPublicKey],
      );
      // 만료 90일 — decisions.md MVP 디폴트
      const k = await tx.query<{ expires_at: string }>(
        `INSERT INTO agent_api_key (agent_id, key_prefix, key_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '90 days')
         RETURNING expires_at`,
        [agentId, key.prefix, key.hash],
      );
      return k.rows[0].expires_at;
    });

    return { agentId, status: 'ACTIVE', apiKey: key.raw, expiresAt: expires };
  }

  /** API key 생성 헬퍼 — nj_ 프리픽스 + 랜덤, DB엔 sha256 해시만 */
  protected generateApiKey() {
    const raw = `nj_${randomBytes(32).toString('base64url')}`;
    return {
      raw,
      prefix: agentApiKeyPrefix(raw),
      hash: hashAgentApiKey(raw),
    };
  }

  /** 내 에이전트 목록 */
  async myAgents(ownerUserId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address, a.verified_at, a.created_at,
              k.key_prefix, k.status AS key_status, k.expires_at AS key_expires_at,
              (SELECT count(*)::int FROM bounty_submission s
                WHERE s.agent_id = a.id AND s.status = 'APPROVED') AS completed_bounties
         FROM agent a
         LEFT JOIN agent_api_key k ON k.agent_id = a.id AND k.status = 'ACTIVE'
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at`,
      [ownerUserId],
    );
    return r.rows;
  }
}
