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
 * 상태 흐름: PENDING → APPROVED / REJECTED (본인 철회 시 WITHDRAWN) - 규칙의 단일 출처는 bounties/application-status.ts
 * 재지원: WITHDRAWN → PENDING (같은 행을 다시 연다 - id 유지, 심사 필드 초기화, 감사 `APPLICATION_REAPPLIED`). docs/decisions.md 참고
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async apply(bountyId: string, userId: string, message: string, portfolioUrl?: string) {
    const actor = BountyActor.user(userId);
    return this.db.tx(async (tx) => {
      const bounty = await tx.query<{
        application_required: boolean;
        status: string; submission_deadline: string; application_deadline: string | null;
      }>(
        `SELECT application_required, status, submission_deadline, application_deadline FROM bounty
          WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [bountyId],
      );
      if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      // 검사 순서가 응답을 정한다: 상태 -> 지원 불필요 -> 마감. 열리지 않은 바운티에는 지원 불필요보다 상태 오류가 맞다.
      if (bounty.rows[0].status !== BountyStatus.OPEN) {
        throw new BadRequestException('BOUNTY_NOT_OPEN');
      }
      if (!bounty.rows[0].application_required) {
        throw new BadRequestException('SUBMISSION_TYPE_BOUNTY'); // 제출형은 바로 제출
      }
      if ([bounty.rows[0].submission_deadline, bounty.rows[0].application_deadline].some((date) => date && new Date(date).getTime() <= Date.now())) throw new BadRequestException('APPLICATION_DEADLINE_PASSED');
      await actor.assertOnboarded(tx);

      // 바운티 행 잠금(FOR UPDATE) 아래라 같은 주체의 동시 지원은 여기서 직렬화된다
      const existing = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM bounty_application
          WHERE bounty_id = $1 AND applicant_user_id = $2 FOR UPDATE`,
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
        // change를 붙이지 않는다: 이 행은 before/after 없이 쌓여 왔고, 바운티는 지원 행에서 찾는다
        await actor.recordAudit(this.audit, 'APPLICATION_REAPPLIED', 'bounty_application', existing.rows[0].id, tx);
        return reopened.rows[0];
      }

      let created: { id: string; status: string; applied_at: string };
      try {
        const r = await tx.query<{ id: string; status: string; applied_at: string }>(
          `INSERT INTO bounty_application
             (bounty_id, applicant_user_id, message, portfolio_url)
           VALUES ($1, $2, $3, $4)
           RETURNING id, status, applied_at`,
          [bountyId, actor.id, message, portfolioUrl ?? null],
        );
        created = r.rows[0];
      } catch (err: unknown) {
        // 같은 사람의 동시 첫 지원만 409로 바꾼다(부분 유니크 인덱스 0004_bounties.sql). 다른 유니크 충돌은 그대로 던져 500으로 드러나게 한다
        if (isUniqueViolation(err, 'uq_application_user')) {
          throw new ConflictException('ALREADY_APPLIED');
        }
        throw err;
      }
      // 신규 지원 감사 - 같은 tx라 감사 INSERT가 실패하면 지원도 롤백된다. 메시지·포트폴리오 URL(사용자 입력)은 넣지 않는다
      await actor.recordAudit(this.audit, 'APPLICATION_SUBMITTED', 'bounty_application', created.id, tx, {
        after: { status: created.status, bountyId },
      });
      return created;
    });
  }

  /** 내 지원 내역. 각 행의 `agent`는 항상 null(에이전트 제거 후에도 FE 계약 호환용 shim, 다음 정리 PR에서 제거) */
  async myApplications(userId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.status, a.message, a.applied_at, a.reviewed_at, a.review_note,
              b.id AS bounty_id, b.title AS bounty_title, b.category,
              b.status AS bounty_status, b.submission_deadline, b.application_deadline,
              NULL::json AS agent
         FROM bounty_application a
         JOIN bounty b ON b.id = a.bounty_id AND b.deleted_at IS NULL -- 삭제된 바운티는 없는 것으로 본다 (링크가 404가 된다)
        WHERE a.applicant_user_id = $1
        ORDER BY a.applied_at DESC`,
      [userId],
    );
    return r.rows;
  }

  /** 지원 철회 - 본인 지원만 (PENDING만). 감사 `APPLICATION_WITHDRAWN`은 같은 tx이고 행위자는 철회한 유저다. */
  async withdraw(applicationId: string, userId: string) {
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ id: string; status: string; bounty_id: string }>(
        `UPDATE bounty_application SET status = 'WITHDRAWN'
          WHERE id = $1 AND status = 'PENDING'
            AND applicant_user_id = $2
          RETURNING id, status, bounty_id`,
        [applicationId, userId],
      );
      if (!r.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
      const { id, status, bounty_id: bountyId } = r.rows[0];
      await this.audit.record(userId, 'APPLICATION_WITHDRAWN', 'bounty_application', id, tx, {
        before: { status: 'PENDING' }, after: { status, bountyId },
      });
      return { id, status };
    });
  }
}
