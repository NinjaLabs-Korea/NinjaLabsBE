import { BadRequestException } from '@nestjs/common';

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
}
