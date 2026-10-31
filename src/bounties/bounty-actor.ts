import { BadRequestException, ConflictException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';

/**
 * 바운티에 지원·제출하는 주체 - 사람(USER) 또는 AI 에이전트(AGENT).
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

  /**
   * bounty_application에서 "주체당 바운티 1행"을 지키는 부분 유니크 인덱스 이름(0004_bounties.sql).
   * INSERT의 23505가 이 인덱스에서 났을 때만 ALREADY_APPLIED로 바꾼다: 다른 유니크 충돌을 중복 지원으로 숨기지 않도록.
   */
  get applicationUniqueIndex(): 'uq_application_user' | 'uq_application_agent' {
    return this.kind === 'USER' ? 'uq_application_user' : 'uq_application_agent';
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
   * 에이전트는 소유자의 온보딩 상태를 따른다: 로그인했다고 온보딩을 마친 것이 아니므로(임시 닉네임·빈 프로필 소유자가 에이전트로 제출하면 운영자 화면에 익명 소유자가 뜬다),
   * 소유자가 온보딩을 끝내지 않았으면 사람과 같이 409 PROFILE_REQUIRED. (등록 시점의 같은 검사는 AgentsService.register.) 호출자의 트랜잭션 안에서 부른다.
   * 유저(에이전트면 소유자)를 FOR SHARE로 잠가 탈퇴의 FOR UPDATE와 직렬화한다. 지원/제출 행을 잠그기 전에 호출해야
   * 탈퇴의 유저 -> 참여 행 잠금 순서와 일치한다. 참여가 먼저면 탈퇴가 커밋된 참여를 철회하고, 탈퇴가 먼저면 여기서 거부한다.
   */
  async assertOnboarded(tx: Pick<DatabaseService, 'query'>): Promise<void> {
    const r =
      this.kind === 'USER'
        ? await tx.query<{ done: boolean }>(
            `SELECT onboarding_completed_at IS NOT NULL AS done FROM "user"
              WHERE id = $1 AND ${activeUserSql('')} FOR SHARE`,
            [this.id],
          )
        : await tx.query<{ done: boolean }>(
            `SELECT u.onboarding_completed_at IS NOT NULL AS done
               FROM agent a JOIN "user" u ON u.id = a.owner_user_id
              WHERE a.id = $1 AND ${activeUserSql('u')} FOR SHARE OF u`,
            [this.id],
          );
    if (!r.rowCount || !r.rows[0].done) throw new ConflictException('PROFILE_REQUIRED');
  }
}
