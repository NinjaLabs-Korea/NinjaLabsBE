import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { isUniqueViolation } from '../../common/database/pg-errors';
import { ApplicationStatusPolicy } from '../application-status';
import { BountyActor } from '../bounty-actor';
import { BountyStatus } from '../bounty-status';

/**
 * 지원형 바운티(application_required = true) 참가 신청
 * 상태 흐름: PENDING → APPROVED / REJECTED (본인 철회 시 WITHDRAWN) — 규칙의 단일 출처는 bounties/application-status.ts
 * 재지원: WITHDRAWN → PENDING (같은 행을 다시 연다 — id 유지, 심사 필드 초기화, 감사 `APPLICATION_REAPPLIED`). docs/decisions.md 참고
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async apply(bountyId: string, userId: string, message: string, portfolioUrl?: string) {
    return this.applyForActor(bountyId, BountyActor.user(userId), message, portfolioUrl);
  }

  async applyAsAgent(bountyId: string, agentId: string, message: string, portfolioUrl?: string) {
    return this.applyForActor(bountyId, BountyActor.agent(agentId), message, portfolioUrl);
  }

  private async applyForActor(
    bountyId: string,
    actor: BountyActor,
    message: string,
    portfolioUrl?: string,
  ) {
    return this.db.tx(async (tx) => {
      const bounty = await tx.query<{
        application_required: boolean;
        submission_mode: string;
        status: string; submission_deadline: string; application_deadline: string | null;
      }>(
        `SELECT application_required, submission_mode, status, submission_deadline, application_deadline FROM bounty
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [bountyId],
      );
      if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      if (!bounty.rows[0].application_required) {
        throw new BadRequestException('SUBMISSION_TYPE_BOUNTY'); // 제출형은 바로 제출
      }
      if (bounty.rows[0].status !== BountyStatus.OPEN) {
        throw new BadRequestException('BOUNTY_NOT_OPEN');
      }
      if ([bounty.rows[0].submission_deadline, bounty.rows[0].application_deadline].some((date) => date && new Date(date).getTime() <= Date.now())) throw new BadRequestException('APPLICATION_DEADLINE_PASSED');
      actor.assertAllowedBy(bounty.rows[0].submission_mode);

      // 바운티 행 잠금(FOR UPDATE) 아래라 같은 주체의 동시 지원은 여기서 직렬화된다
      const existing = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM bounty_application
          WHERE bounty_id = $1 AND ${actor.applicationColumn} = $2 FOR UPDATE`,
        [bountyId, actor.id],
      );
      if (existing.rowCount) {
        if (!ApplicationStatusPolicy.canReapply(existing.rows[0].status)) throw new ConflictException('ALREADY_APPLIED');
        const reopened = await tx.query(
          `UPDATE bounty_application
              SET status = 'PENDING', message = $2, portfolio_url = $3, applied_at = now(),
                  reviewed_by = NULL, reviewed_at = NULL, review_note = NULL
            WHERE id = $1 AND status = 'WITHDRAWN'
          RETURNING id, status, applied_at`,
          [existing.rows[0].id, message, portfolioUrl ?? null],
        );
        // 에이전트 키로 낸 재지원은 유저 id가 없다 — 행위자 없는 행은 운영 스크립트 기록으로 읽히므로 에이전트 id를 남긴다
        if (actor.kind === 'AGENT') await this.audit.recordAgentAction(actor.id, 'APPLICATION_REAPPLIED', 'bounty_application', existing.rows[0].id, tx);
        else await this.audit.record(actor.id, 'APPLICATION_REAPPLIED', 'bounty_application', existing.rows[0].id, tx);
        return reopened.rows[0];
      }

      try {
        const r = await tx.query(
          `INSERT INTO bounty_application
             (bounty_id, applicant_user_id, agent_id, message, portfolio_url)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, status, applied_at`,
          [bountyId, actor.userId, actor.agentId,
           message, portfolioUrl ?? null],
        );
        return r.rows[0];
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('ALREADY_APPLIED');
        }
        throw err;
      }
    });
  }

  /** 내 지원 내역 — 본인이 낸 것 + 내가 소유한 에이전트가 낸 것. 각 행에 agent {id, name} | null */
  async myApplications(userId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.status, a.message, a.applied_at, a.reviewed_at, a.review_note,
              b.id AS bounty_id, b.title AS bounty_title, b.category,
              CASE WHEN ag.id IS NULL THEN NULL
                   ELSE json_build_object('id', ag.id, 'name', ag.name) END AS agent
         FROM bounty_application a
         JOIN bounty b ON b.id = a.bounty_id
         LEFT JOIN agent ag ON ag.id = a.agent_id
        WHERE a.applicant_user_id = $1
           OR a.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL))
        ORDER BY a.applied_at DESC`,
      [userId],
    );
    return r.rows;
  }

  /** 지원 철회 — 본인 지원 또는 내 에이전트의 지원 (PENDING만) */
  async withdraw(applicationId: string, userId: string) {
    const r = await this.db.query(
      `UPDATE bounty_application SET status = 'WITHDRAWN'
        WHERE id = $1 AND status = 'PENDING'
          AND (applicant_user_id = $2
               OR agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $2 AND deleted_at IS NULL)))
        RETURNING id, status`,
      [applicationId, userId],
    );
    if (!r.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
    return r.rows[0];
  }
}
