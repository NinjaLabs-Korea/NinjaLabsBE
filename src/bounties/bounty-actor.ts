import { ConflictException } from '@nestjs/common';
import { AuditChange, AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS, AuditAction } from '../audit/audit-actions';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';

/**
 * 바운티에 지원·제출하는 주체. 구글 로그인 전용 전환(에이전트 제거) 이후 사람(USER)뿐이다.
 * 지원/제출 자격 검사(assertOnboarded)와 감사 행 기록(recordAudit)만 모아 둔다.
 */
export class BountyActor {
  private constructor(readonly id: string) {}

  static user(userId: string): BountyActor {
    return new BountyActor(userId);
  }

  /** 이 사람이 한 행위의 감사 행(`actor_user_id`). 트랜잭션 안이면 tx를 넘긴다. */
  async recordAudit<A extends AuditAction>(
    audit: AuditService,
    action: A,
    entityType: (typeof AUDIT_ACTIONS)[A],
    entityId: string,
    runner: QueryRunner,
    change?: AuditChange,
  ): Promise<void> {
    await audit.record(this.id, action, entityType, entityId, runner, change);
  }

  /**
   * 온보딩을 마치지 않은 사람은 지원·제출할 수 없다: 임시 닉네임(`user_xxxx`)·빈 프로필인 채로 운영자 심사 화면에 익명 지원자가 뜨는 것을 막는다.
   * FE는 같은 조건(onboardingCompleted)으로 이 사용자를 /signup으로 보내므로 API를 직접 부를 때만 닿는다. 409 PROFILE_REQUIRED(온보딩 완료와 같은 코드).
   * 호출자의 트랜잭션 안에서 부른다. 유저를 FOR SHARE로 잠가 탈퇴의 FOR UPDATE와 직렬화한다. 지원/제출 행을 잠그기 전에 호출해야
   * 탈퇴의 유저 -> 참여 행 잠금 순서와 일치한다. 참여가 먼저면 탈퇴가 커밋된 참여를 철회하고, 탈퇴가 먼저면 여기서 거부한다.
   */
  async assertOnboarded(tx: Pick<DatabaseService, 'query'>): Promise<void> {
    const r = await tx.query<{ done: boolean }>(
      `SELECT onboarding_completed_at IS NOT NULL AS done FROM "user"
        WHERE id = $1 AND ${activeUserSql('')} FOR SHARE`,
      [this.id],
    );
    if (!r.rowCount || !r.rows[0].done) throw new ConflictException('PROFILE_REQUIRED');
  }
}
