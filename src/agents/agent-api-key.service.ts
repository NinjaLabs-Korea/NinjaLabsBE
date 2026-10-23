import { Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import {
  AGENT_API_KEY_MARKER,
  agentApiKeyPrefix,
  hashAgentApiKey,
} from './agent-api-key';

interface AgentApiKeyRow {
  api_key_id: string;
  key_hash: string;
  key_status: string;
  expires_at: Date | string | null;
  agent_id: string;
  owner_user_id: string;
  agent_name: string;
  wallet_address: string;
  agent_status: string;
}

export interface AgentPrincipal {
  agentId: string;
  ownerUserId: string;
  name: string;
  walletAddress: string;
  apiKeyId: string;
}

@Injectable()
export class AgentApiKeyService {
  constructor(private readonly db: DatabaseService) {}

  async authenticate(rawKey: string): Promise<AgentPrincipal> {
    if (!rawKey.startsWith(AGENT_API_KEY_MARKER) || rawKey.length < 16) {
      throw this.invalidKey();
    }

    const presentedHash = Buffer.from(hashAgentApiKey(rawKey), 'hex');

    // 잠금/트랜잭션 없음 — 인증은 읽기이고 last_used_at 갱신은 조건부 단일 UPDATE라 잠글 이유가 없다.
    // (예전의 FOR UPDATE는 모든 Agent API 요청을 키 행에 직렬화해 rotate/revoke와 경합하는 병목이었다.)
    const candidates = await this.db.query<AgentApiKeyRow>(
      `SELECT k.id AS api_key_id, k.key_hash, k.status AS key_status, k.expires_at,
              a.id AS agent_id, a.owner_user_id, a.name AS agent_name,
              a.wallet_address, a.status AS agent_status
         FROM agent_api_key k
         JOIN agent a ON a.id = k.agent_id
        WHERE k.key_prefix = $1 AND a.deleted_at IS NULL`,
      [agentApiKeyPrefix(rawKey)],
    );

    const matched = candidates.rows.find((candidate) => {
      if (!/^[0-9a-f]{64}$/i.test(candidate.key_hash)) return false;
      const storedHash = Buffer.from(candidate.key_hash, 'hex');
      return (
        storedHash.length === presentedHash.length &&
        timingSafeEqual(storedHash, presentedHash)
      );
    });

    if (!matched || !this.isActive(matched)) throw this.invalidKey();

    // 조회와 갱신 사이에 폐기/만료됐으면 여기서 0행 → 거부 (상태 조건을 UPDATE가 다시 평가한다)
    const touched = await this.db.query(
      `UPDATE agent_api_key
          SET last_used_at = now()
        WHERE id = $1 AND status = 'ACTIVE' AND expires_at > now()
        RETURNING id`,
      [matched.api_key_id],
    );
    if (!touched.rowCount) throw this.invalidKey();

    return {
      agentId: matched.agent_id,
      ownerUserId: matched.owner_user_id,
      name: matched.agent_name,
      walletAddress: matched.wallet_address,
      apiKeyId: matched.api_key_id,
    };
  }

  private isActive(row: AgentApiKeyRow): boolean {
    if (row.key_status !== 'ACTIVE' || row.agent_status !== 'ACTIVE' || !row.expires_at) {
      return false;
    }
    const expiresAt = new Date(row.expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
  }

  private invalidKey(): UnauthorizedException {
    return new UnauthorizedException('INVALID_AGENT_API_KEY');
  }
}
