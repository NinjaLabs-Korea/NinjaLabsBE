import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { DatabaseService } from '../common/database/database.service';
import { WITHDRAWN_NICKNAME_PREFIX } from './nickname';

/** payout 종료 상태 — 이 밖의 상태(REQUESTED/AWAITING_MULTISIG_APPROVAL/APPROVED/BROADCASTING)가 하나라도 있으면 탈퇴를 막는다 */
export const TERMINAL_PAYOUT_STATUSES = ['PAID', 'CANCELLED', 'FAILED'] as const;

/** 심사가 끝나지 않은 제출 상태 — 탈퇴 시 WITHDRAWN으로 철회한다 (bounty-lifecycle의 unresolved 집합과 같다) */
export const OPEN_SUBMISSION_STATUSES = ['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW', 'REVISION_REQUESTED'] as const;

/** 탈퇴 행의 google_id/email 앞에 붙는 프리픽스 — `deleted:<epoch ms>:` */
export function withdrawnIdentityPrefix(nowMs: number): string {
  return `deleted:${nowMs}:`;
}

/** 탈퇴 확인 문구 비교 — 앞뒤 공백 무시, 대소문자 무시 (닉네임 유니크 인덱스도 lower(nickname) 기준) */
export function nicknameConfirmed(current: string, typed: string): boolean {
  return current.trim().toLowerCase() === typed.trim().toLowerCase();
}

/**
 * 회원 탈퇴 (docs/decisions.md "사용자" — 탈퇴 시 NFT/에이전트 처리, 동일 구글 계정 재가입).
 *
 * 한 트랜잭션에서, 유저 행을 먼저 잠그고(FOR UPDATE):
 *   1. 확인 닉네임 불일치 → 400 CONFIRM_NICKNAME_MISMATCH
 *   2. 본인(또는 내 에이전트) 제출에 걸렸거나 내 지갑으로 가는 payout 중 종료 상태가 아닌 것이 있으면 → 409 WITHDRAWAL_BLOCKED_OPEN_PAYOUTS
 *   3. user: status WITHDRAWN, deleted_at = now(), google_id/email에 `deleted:<ms>:` 프리픽스(같은 구글 계정 재가입 — 0014 부분 유니크 인덱스가
 *      deleted_at IS NULL 행만 보므로 충돌은 없지만, 원래 식별자로 다시 찾히지 않게 한다), 닉네임은 `withdrawn_<id 앞 8자>`로 익명화,
 *      bio 비움, 멤버/운영자 플래그 해제. user_link/user_tag 삭제
 *   4. auth_session 전부 폐기 (refresh 불가), 지갑 연결 해제(disconnected_at — 같은 주소로 새 계정 연결 가능; payout/NFT FK는 행이 남아 유지)
 *   5. 소유 에이전트 전부 REVOKED + 키 REVOKED (각각 감사 AGENT_REVOKED)
 *   6. 본인/내 에이전트의 심사 전 제출(SUBMITTED/RESUBMITTED/IN_REVIEW/REVISION_REQUESTED)과 PENDING 지원 → WITHDRAWN
 *   7. 감사 USER_WITHDRAWN
 * 승인/반려된 제출·payout·NFT 기록은 그대로 남는다 (표시 이름은 익명화된 닉네임). AuthGuard 상태 캐시는 커밋 뒤 이 프로세스에서 즉시 비운다.
 */
@Injectable()
export class AccountWithdrawalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async withdraw(userId: string, confirmNickname: string, nowMs = Date.now()): Promise<{ ok: true }> {
    await this.db.tx(async (tx) => {
      const user = await tx.query<{ nickname: string }>(
        `SELECT nickname FROM "user"
          WHERE id = $1 AND deleted_at IS NULL AND status = 'ACTIVE'
          FOR UPDATE`,
        [userId],
      );
      if (!user.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      if (!nicknameConfirmed(user.rows[0].nickname, confirmNickname)) {
        throw new BadRequestException('CONFIRM_NICKNAME_MISMATCH');
      }

      const open = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM payout p
           JOIN bounty_submission s ON s.id = p.submission_id
          WHERE p.status <> ALL($2::text[])
            AND (s.submitter_user_id = $1
                 OR s.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1))
                 OR p.recipient_wallet_id = ANY(ARRAY(SELECT id FROM wallet WHERE user_id = $1)))`,
        [userId, [...TERMINAL_PAYOUT_STATUSES]],
      );
      if (open.rows[0].n > 0) throw new ConflictException('WITHDRAWAL_BLOCKED_OPEN_PAYOUTS');

      const prefix = withdrawnIdentityPrefix(nowMs);
      await tx.query(
        `UPDATE "user"
            SET status = 'WITHDRAWN', deleted_at = now(),
                google_id = left($2 || google_id, 255),
                email = left($2 || email, 320),
                nickname = $3 || left(replace(id::text, '-', ''), 8),
                bio = '', is_member = false, member_role = NULL, member_display_order = NULL, is_admin = false
          WHERE id = $1`,
        [userId, prefix, WITHDRAWN_NICKNAME_PREFIX],
      );
      await tx.query(`DELETE FROM user_link WHERE user_id = $1`, [userId]);
      await tx.query(`DELETE FROM user_tag WHERE user_id = $1`, [userId]);
      await tx.query(
        `UPDATE auth_session SET revoked_at = now(), grace_refresh_token = NULL
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
      await tx.query(
        `UPDATE wallet SET disconnected_at = now()
          WHERE user_id = $1 AND disconnected_at IS NULL`,
        [userId],
      );

      const agents = await tx.query<{ id: string }>(
        `UPDATE agent SET status = 'REVOKED'
          WHERE owner_user_id = $1 AND deleted_at IS NULL AND status <> 'REVOKED'
          RETURNING id`,
        [userId],
      );
      await tx.query(
        `UPDATE agent_api_key SET status = 'REVOKED', revoked_at = now()
          WHERE status = 'ACTIVE' AND agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1))`,
        [userId],
      );
      for (const agent of agents.rows) {
        await this.audit.record(userId, 'AGENT_REVOKED', 'agent', agent.id, tx);
      }

      // 아직 심사가 끝나지 않은 제출도 철회한다 — 남겨 두면 운영자가 승인해 max_winners 자리를 지급 불가능한 제출이 차지하거나
      // (수령 지갑이 없어 requestPayout 404), 미결 제출로 남아 바운티 완료(COMPLETED)를 막는다. 승인/반려된 제출은 기록으로 남는다.
      await tx.query(
        `UPDATE bounty_submission SET status = 'WITHDRAWN'
          WHERE status = ANY($2::text[])
            AND (submitter_user_id = $1
                 OR agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1)))`,
        [userId, [...OPEN_SUBMISSION_STATUSES]],
      );
      await tx.query(
        `UPDATE bounty_application SET status = 'WITHDRAWN'
          WHERE status = 'PENDING'
            AND (applicant_user_id = $1
                 OR agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1)))`,
        [userId],
      );

      await this.audit.record(userId, 'USER_WITHDRAWN', 'user', userId, tx);
    });
    this.auth.forgetUserStatus(userId);
    return { ok: true };
  }
}
