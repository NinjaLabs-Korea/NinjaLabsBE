import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { getInjectiveAddress } from '@injectivelabs/sdk-ts';
import { getAddress, isAddress } from 'ethers';
import { AuditService } from '../audit/audit.service';
import { canonicalPublicKeyBase64 } from '../common/crypto/canonical-public-key';
import { injectivePublicKeyMatchesAddress } from '../common/crypto/injective-public-key';
import { isEvmAddress, signatureSchemeFor } from '../common/crypto/wallet-signature';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { BountyActor } from '../bounties/bounty-actor';
import { agentApiKeyPrefix, hashAgentApiKey } from './agent-api-key';
import { revokeActiveAgentKeys } from './agent-revocation';

/**
 * AI 에이전트 등록 (ERD §12, 기획 PART 2-4)
 *
 * 등록 검증: 유저가 "내 에이전트"임을 지갑 서명으로 증명
 *   1. 유저가 에이전트의 public_key + wallet_address 제출
 *   2. 주인 지갑 private key로 서명 → 서버가 public key로 검증
 *   3. 검증 성공 → agent ACTIVE + API key 발급 (원문 1회 노출, DB엔 해시만)
 */
/** inj1 계정 주소(20바이트) 모양 - bech32 소문자 문자 집합 38자. 체크섬은 공개키↔주소 대조(injectivePublicKeyMatchesAddress)가 잡는다 */
const INJ_ACCOUNT_ADDRESS = /^inj1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/;

@Injectable()
export class AgentsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async register(
    ownerUserId: string,
    name: string,
    description: string | undefined,
    publicKey: string | undefined,
    walletAddress: string,
  ) {
    const isEvm = isEvmAddress(walletAddress);
    if (isEvm && !isAddress(walletAddress.trim())) {
      throw new BadRequestException('INVALID_AGENT_WALLET_ADDRESS');
    }
    // 주소부터 분류한다: 0x도 inj1도 아닌 값(`cosmos1…`)이 공개키 이야기("AGENT_PUBLIC_KEY_REQUIRED")를 듣지 않게.
    // bech32는 전부 대문자도 유효한 같은 주소라 소문자로 접고(섞인 대소문자는 bech32가 아니다), 저장·비교는 소문자 한 가지로만 한다.
    const trimmed = walletAddress.trim();
    const inj1Address = trimmed === trimmed.toUpperCase() ? trimmed.toLowerCase() : trimmed;
    if (!isEvm && !INJ_ACCOUNT_ADDRESS.test(inj1Address)) {
      throw new BadRequestException('INVALID_AGENT_WALLET_ADDRESS');
    }
    if (!isEvm && !publicKey) {
      throw new BadRequestException('AGENT_PUBLIC_KEY_REQUIRED');
    }
    const normalizedAddress = isEvm ? getAddress(trimmed) : inj1Address;
    // 저장할 공개키 — 검증되지 않은 키는 uq_agent_public_key를 선점해 그 키 주인의 등록/verify를 막는 데 쓰일 수 있다.
    //   - EVM(0x): 클라이언트 값은 무시하고 NULL — 키는 verify 때 EIP-191 서명에서 복원한 것만 저장한다 (docs/agent-api.md:
    //     EVM은 publicKey를 보내지 않는다. 예전 클라이언트 호환을 위해 400 대신 무시)
    //   - inj1: ADR-36 verify가 이 키로 검증하므로 필요하다. 대신 그 주소의 키인지 지금 확인한다 (남의 키 → 400)
    if (!isEvm && !injectivePublicKeyMatchesAddress(normalizedAddress, publicKey!)) {
      throw new BadRequestException('AGENT_PUBLIC_KEY_MISMATCH');
    }
    const storedPublicKey = isEvm ? null : canonicalPublicKeyBase64(publicKey!); // 위 일치 검사를 통과했으므로 33바이트 — 클라이언트가 보낸 문자열이 아니라 정규 표기를 저장한다

    try {
      // 같은 지갑/키를 점유한 행 확인(남의 버려진 PENDING은 soft delete)과 INSERT를 한 트랜잭션에서 — 유니크 위반이면 전체가 롤백되고 아래 catch로 간다
      const r = await this.db.tx(async (tx) => {
        await this.retireReusableAgents(tx, ownerUserId, storedPublicKey, normalizedAddress);
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO agent (owner_user_id, name, description, public_key, wallet_address)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [ownerUserId, name, description ?? null, storedPublicKey, normalizedAddress],
        );
        // 본인 지갑 검사는 INSERT 뒤에 한다: 던지면 이 트랜잭션 전체(위의 버려진 행 정리 포함)가 롤백된다
        await this.assertNotOwnerWallet(tx, ownerUserId, isEvm ? getInjectiveAddress(normalizedAddress) : normalizedAddress);
        // 온보딩을 마치지 않은 소유자는 에이전트를 만들 수 없다 (409 PROFILE_REQUIRED, 사람의 지원·제출과 같은 규칙). 던지면 위 INSERT도 롤백된다
        await BountyActor.user(ownerUserId).assertOnboarded(tx);
        return inserted;
      });
      return {
        agentId: r.rows[0].id,
        status: 'PENDING_VERIFICATION',
        // 에이전트 지갑 키로 이 메시지를 ADR-36 서명해 /agents/:id/verify로 제출
        verificationMessage: AgentsService.verificationMessage(r.rows[0].id, ownerUserId),
      };
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        // 같은 지갑으로 다시 등록하면 새로 입력한 이름·설명이 이긴다 - 예전엔 첫 등록의 값을 말없이 유지해 사용자가 바꾼 이름이 버려졌다.
        // 아직 검증 전(PENDING_VERIFICATION)인 내 행만 고친다 (검증된 에이전트의 이름은 이 경로로 바뀌지 않는다)
        const pending = await this.db.query<{ id: string }>(
          `UPDATE agent SET name = $3, description = $4
            WHERE owner_user_id = $1 AND wallet_address = $2
              AND status = 'PENDING_VERIFICATION' AND deleted_at IS NULL
           RETURNING id`,
          [ownerUserId, normalizedAddress, name, description ?? null],
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
   * 같은 지갑/공개키를 점유한 행을 확인해 재등록을 허용할지 정한다. 행을 잠근 채(FOR UPDATE) 처리해 동시 재등록·revoke·verify와
   * 엇갈리지 않는다. uq_agent_wallet/uq_agent_public_key(0014)는 `deleted_at IS NULL AND status <> 'REVOKED'` 행만 보므로
   * REVOKED 행은 지우지 않아도 지갑/키가 풀린다.
   *   - 내 REVOKED 에이전트 → 그대로 둔다 (soft delete 하지 않음 — 제출/지원 이력이 /agents/me 와 프로필에 계속 보인다)
   *   - 남의 REVOKED 에이전트 → 409 — 단, **한 번도 verify되지 않은** 것(verified_at IS NULL)은 막지 않는다. PENDING 행을 만들어 바로 폐기(revoke)하면
   *     소유 증명 없이 남의 지갑/키를 영구히 점유할 수 있었다 (24시간 만료를 우회). 검증된 적 없는 행은 이력(키·제출·지원)도 없다
   *   - 남의 PENDING_VERIFICATION 에이전트 → 등록 후 24시간이 지났으면 버려진 것으로 보고 soft delete.
   *     PENDING 행은 소유를 증명하지 않는다(증명은 verify의 서명) — 누구나 남의 지갑 주소를 먼저 등록해 선점(squatting)할 수 있으므로.
   *     24시간 이내면 서명 제출 중일 수 있어 409
   *   - 내 PENDING 행은 건드리지 않는다 — INSERT가 유니크 위반으로 실패하고 register()가 그 행을 그대로 돌려준다
   */
  /**
   * 에이전트 지갑은 소유자 본인의 연결 지갑과 달라야 한다 (등록 화면·skill.md의 "must differ from your own wallet" 규칙의 서버 쪽 집행).
   * 지갑 테이블은 inj1 표기로 저장하므로 0x 주소는 inj1로 바꿔 비교한다. 연결 해제된 지갑은 본인 지갑이 아니다.
   */
  private async assertNotOwnerWallet(tx: Pick<DatabaseService, 'query'>, ownerUserId: string, injectiveAddress: string): Promise<void> {
    const own = await tx.query<{ address: string }>(
      `SELECT address FROM wallet WHERE user_id = $1 AND disconnected_at IS NULL`,
      [ownerUserId],
    );
    if (own.rows.some((row) => row.address.toLowerCase() === injectiveAddress.toLowerCase())) {
      throw new BadRequestException('AGENT_WALLET_IS_OWNER_WALLET');
    }
  }

  private async retireReusableAgents(
    tx: QueryRunner,
    ownerUserId: string,
    publicKey: string | null,
    walletAddress: string,
  ) {
    const occupied = (await tx.query(
      `SELECT id, owner_user_id, status, verified_at IS NOT NULL AS verified,
              (status = 'PENDING_VERIFICATION' AND created_at < now() - interval '24 hours') AS abandoned
         FROM agent
        WHERE (wallet_address = $1 OR ($2::text IS NOT NULL AND public_key = $2::text))
          AND status IN ('REVOKED', 'PENDING_VERIFICATION') AND deleted_at IS NULL
        FOR UPDATE`,
      [walletAddress, publicKey],
    )) as { rows: Array<{ id: string; owner_user_id: string; status: string; verified: boolean; abandoned: boolean }> };
    const retire: string[] = [];
    for (const row of occupied.rows) {
      const mine = row.owner_user_id === ownerUserId;
      if (row.status === 'REVOKED') {
        if (!mine && row.verified) throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
        // 내 REVOKED 행, 남의 검증된 적 없는 REVOKED 행: 유니크 인덱스가 무시하므로 건드리지 않는다
      } else if (!mine) {
        if (!row.abandoned) throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
        retire.push(row.id);
      }
    }
    if (!retire.length) return;
    await tx.query(
      `UPDATE agent SET deleted_at = now() WHERE id = ANY($1::uuid[])`,
      [retire],
    );
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
   * inj1은 등록 시 저장한(주소와 대조된) public_key로, 0x는 서명에서 복원한 키로 검증하므로 서명 주체 = 에이전트 지갑 키 소유자.
   * 검증 성공 시에만 API key를 반환한다 (원문은 이 응답 1회뿐).
   */
  async verifyAndIssueKey(ownerUserId: string, agentId: string, signature: string) {
    const key = this.generateApiKey();
    // 상태 확인 → 서명 검증 → ACTIVE 전환 → key 발급을 한 트랜잭션에서, 에이전트 행을 잠근 채 수행한다.
    // 동시 verify 두 번이면 두 번째는 잠금 해제 후 ACTIVE를 보고 AGENT_ALREADY_VERIFIED로 거부된다.
    const expires = await this.db.tx(async (tx) => {
      const r = await tx.query<{
        status: string;
        public_key: string | null;
        wallet_address: string;
        verified_at: Date | null;
      }>(
        `SELECT status, public_key, wallet_address, verified_at FROM agent
          WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
          FOR UPDATE`,
        [agentId, ownerUserId],
      );
      if (!r.rowCount) throw new NotFoundException('AGENT_NOT_FOUND');
      const agent = r.rows[0];
      if (agent.status !== 'PENDING_VERIFICATION') {
        // 검증을 마친 적 있는 에이전트(ACTIVE, 또는 그 뒤 정지·폐기)만 "이미 검증됨"이다 - 검증 전에 폐기된 에이전트는 키를 받은 적이 없다
        throw new ConflictException(agent.status === 'ACTIVE' || agent.verified_at ? 'AGENT_ALREADY_VERIFIED' : 'AGENT_NOT_PENDING');
      }

      const message = AgentsService.verificationMessage(agentId, ownerUserId);
      const verified = signatureSchemeFor(agent.wallet_address).verify({
        address: agent.wallet_address,
        message,
        signature,
        publicKey: agent.public_key,
      });
      if (!verified) {
        throw new UnauthorizedException('INVALID_SIGNATURE');
      }

      if (verified.publicKey && isEvmAddress(agent.wallet_address)) {
        // 이 수정 전 등록된 EVM PENDING 행에는 클라이언트가 보낸(검증 안 된) public_key가 남아 있을 수 있다 — 남의 키를 붙여 둔 행이
        // 아래 UPDATE를 uq_agent_public_key 위반으로 막지 않도록, 서명으로 방금 증명된 이 키를 쥔 다른 EVM PENDING 행의 키를 비운다.
        // EVM verify는 저장된 키를 쓰지 않으므로(서명에서 복원) 그 행들의 동작은 바뀌지 않는다.
        await tx.query(
          `UPDATE agent SET public_key = NULL
            WHERE public_key = $1 AND id <> $2 AND status = 'PENDING_VERIFICATION' AND deleted_at IS NULL
              AND wallet_address ILIKE '0x%'`,
          [verified.publicKey, agentId],
        );
      }
      await tx.query(
        `UPDATE agent
            SET status = 'ACTIVE', verified_at = now(), public_key = COALESCE($2, public_key)
          WHERE id = $1`,
        [agentId, verified.publicKey],
      );
      const expiresAt = await this.insertKey(tx, agentId, key);
      // 첫 API key 발급도 rotate와 같은 자격 증명 발급이다 — 감사 없이는 ACTIVE 에이전트가 언제 생겼는지 알 수 없다
      await this.audit.record(ownerUserId, 'AGENT_VERIFIED', 'agent', agentId, tx);
      return expiresAt;
    }).catch((err: unknown) => {
      // 그래도 이 키를 쥔 다른 행(ACTIVE 등)이 있으면 500이 아니라 409 — 트랜잭션은 이미 롤백됐다
      if (isUniqueViolation(err, 'uq_agent_public_key')) {
        throw new ConflictException('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
      }
      throw err;
    });

    return { agentId, status: 'ACTIVE', apiKey: key.raw, expiresAt: expires };
  }

  /** API key 행 삽입 — 만료 90일 (decisions.md MVP 디폴트). verify와 rotate가 공유한다. */
  private async insertKey(tx: QueryRunner, agentId: string, key: { prefix: string; hash: string }) {
    const k = (await tx.query(
      `INSERT INTO agent_api_key (agent_id, key_prefix, key_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '90 days')
       RETURNING expires_at`,
      [agentId, key.prefix, key.hash],
    )) as { rows: Array<{ expires_at: string }> };
    return k.rows[0].expires_at;
  }

  /**
   * API key 재발급 — ACTIVE 에이전트의 기존 ACTIVE 키를 모두 폐기하고 새 키 1개를 발급한다.
   * 에이전트 행을 잠근 채 한 트랜잭션에서 수행하므로 동시 rotate 두 번도 유효 키는 항상 1개다.
   * 새 키 원문은 이 응답에서만 노출된다.
   */
  async rotateKey(ownerUserId: string, agentId: string) {
    const key = this.generateApiKey();
    const expires = await this.db.tx(async (tx) => {
      const agent = await this.lockOwnedAgent(tx, ownerUserId, agentId);
      if (agent.status !== 'ACTIVE') throw new ConflictException('AGENT_NOT_ACTIVE');
      await revokeActiveAgentKeys(tx, agentId);
      const expiresAt = await this.insertKey(tx, agentId, key);
      await this.audit.record(ownerUserId, 'AGENT_KEY_ROTATED', 'agent', agentId, tx);
      return expiresAt;
    });
    return { agentId, apiKey: key.raw, expiresAt: expires };
  }

  /**
   * 에이전트 폐기 — 에이전트 REVOKED + 모든 ACTIVE 키 REVOKED (Agent API 인증 즉시 거부).
   * 이미 REVOKED면 아무것도 바꾸지 않고 같은 응답을 돌려준다 (멱등).
   */
  async revoke(ownerUserId: string, agentId: string) {
    await this.db.tx(async (tx) => {
      const agent = await this.lockOwnedAgent(tx, ownerUserId, agentId);
      if (agent.status === 'REVOKED') return;
      await tx.query(`UPDATE agent SET status = 'REVOKED' WHERE id = $1`, [agentId]);
      await revokeActiveAgentKeys(tx, agentId);
      await this.audit.record(ownerUserId, 'AGENT_REVOKED', 'agent', agentId, tx);
    });
    return { agentId, status: 'REVOKED' };
  }

  /** 내 에이전트 행 잠금 — 남의 에이전트/삭제된 에이전트는 404 (존재 여부를 노출하지 않음) */
  private async lockOwnedAgent(tx: QueryRunner, ownerUserId: string, agentId: string) {
    const r = (await tx.query(
      `SELECT status FROM agent
        WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
        FOR UPDATE`,
      [agentId, ownerUserId],
    )) as { rowCount: number | null; rows: Array<{ status: string }> };
    if (!r.rowCount) throw new NotFoundException('AGENT_NOT_FOUND');
    return r.rows[0];
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

  /**
   * 내 에이전트 목록 — 에이전트당 정확히 1행. 키는 최신 ACTIVE 키 1개(없으면 최신 키)만 LATERAL로 붙인다.
   * key_status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | null — EXPIRED는 expires_at <= now()로 계산한다.
   */
  async myAgents(ownerUserId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address, a.verified_at, a.created_at,
              k.key_prefix,
              CASE WHEN k.id IS NULL THEN NULL
                   WHEN k.status = 'ACTIVE' AND k.expires_at <= now() THEN 'EXPIRED'
                   ELSE k.status END AS key_status,
              k.expires_at AS key_expires_at,
              (SELECT count(*)::int FROM bounty_submission s
                 JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL -- 공개 프로필 completedBounties와 같은 기준: 삭제된 바운티는 세지 않는다
                WHERE s.agent_id = a.id AND s.status = 'APPROVED') AS completed_bounties
         FROM agent a
         LEFT JOIN LATERAL (
              SELECT id, key_prefix, status, expires_at FROM agent_api_key
               WHERE agent_id = a.id
               ORDER BY (status = 'ACTIVE') DESC, created_at DESC
               LIMIT 1) k ON true
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.created_at`,
      [ownerUserId],
    );
    return r.rows;
  }
}
