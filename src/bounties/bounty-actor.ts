import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

/**
 * 바운티에 지원·제출하는 주체 — 사람(USER) 또는 AI 에이전트(AGENT).
 *
 * 두 주체는 같은 테이블을 쓰지만 채우는 컬럼이 다르다. 서비스 코드에서
 * `isAgent ? ... : ...` 분기를 반복하지 않도록 차이를 이 클래스에 모은다.
 * 새로운 주체 유형이 생기면 여기만 확장한다.
 */
export class BountyActor {
  private constructor(
    readonly kind: 'USER' | 'AGENT',
    readonly id: string,
  ) {}

  static user(userId: string): BountyActor {
    return new BountyActor('USER', userId);
  }

  static agent(agentId: string): BountyActor {
    return new BountyActor('AGENT', agentId);
  }

  /** INSERT 시 user 컬럼 값 (에이전트면 null) */
  get userId(): string | null {
    return this.kind === 'USER' ? this.id : null;
  }

  /** INSERT 시 agent_id 컬럼 값 (사람이면 null) */
  get agentId(): string | null {
    return this.kind === 'AGENT' ? this.id : null;
  }

  /** bounty_application에서 이 주체를 식별하는 컬럼 */
  get applicationColumn(): 'applicant_user_id' | 'agent_id' {
    return this.kind === 'USER' ? 'applicant_user_id' : 'agent_id';
  }

  /** bounty_submission에서 이 주체를 식별하는 컬럼 */
  get submissionColumn(): 'submitter_user_id' | 'agent_id' {
    return this.kind === 'USER' ? 'submitter_user_id' : 'agent_id';
  }

  /**
   * 바운티의 제출 방식(submission_mode)이 이 주체를 허용하는지 확인한다.
   * AGENT 전용 바운티에 사람이, DIRECT 바운티에 에이전트가 참여하면 거부한다.
   */
  assertAllowedBy(submissionMode: string): void {
    if (submissionMode === 'AGENT' && this.kind !== 'AGENT') {
      throw new BadRequestException('AGENT_SUBMISSION_REQUIRED');
    }
    if (submissionMode === 'DIRECT' && this.kind !== 'USER') {
      throw new BadRequestException('DIRECT_SUBMISSION_REQUIRED');
    }
  }

  /**
   * 온보딩을 마치지 않은 사람은 지원·제출할 수 없다: 임시 닉네임(`user_xxxx`)·빈 프로필인 채로 운영자 심사 화면에 익명 지원자가 뜨는 것을 막는다.
   * FE는 같은 조건(onboardingCompleted)으로 이 사용자를 /signup으로 보내므로 API를 직접 부를 때만 닿는다. 409 PROFILE_REQUIRED(온보딩 완료와 같은 코드).
   * 에이전트는 키로 인증하고 소유자가 등록 시점에 이미 로그인한 사용자라 검사하지 않는다. 호출자의 트랜잭션 안에서 부른다.
   */
  async assertOnboarded(tx: Pick<DatabaseService, 'query'>): Promise<void> {
    if (this.kind !== 'USER') return;
    const r = await tx.query<{ done: boolean }>(
      `SELECT onboarding_completed_at IS NOT NULL AS done FROM "user" WHERE id = $1 AND deleted_at IS NULL`,
      [this.id],
    );
    if (!r.rowCount || !r.rows[0].done) throw new ConflictException('PROFILE_REQUIRED');
  }
}
