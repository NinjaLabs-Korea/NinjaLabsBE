import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { BountyStatusPolicy } from '../bounty-status';

/** 운영자의 제출물 심사 — 심사 시작/수정 요청/승인/반려와 리비전별 심사 기록 */
@Injectable()
export class SubmissionReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async review(submissionId: string, decision: string, comment: string | undefined, adminId: string, revisionNo?: number) {
    const statusMap: Record<string, string> = {
      START_REVIEW: 'IN_REVIEW',
      REQUEST_REVISION: 'REVISION_REQUESTED',
      APPROVE: 'APPROVED',
      REJECT: 'REJECTED',
    };
    const newStatus = statusMap[decision];
    if (!newStatus) throw new NotFoundException('INVALID_DECISION');

    return this.db.tx(async (tx) => {
      const parent = await tx.query(`SELECT b.id, b.status, b.max_winners FROM bounty b JOIN bounty_submission s ON s.bounty_id = b.id
        WHERE s.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [submissionId]);
      if (!parent.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      if (!BountyStatusPolicy.isInProgress(parent.rows[0].status)) throw new BadRequestException('BOUNTY_REVIEW_CLOSED');
      const sub = await tx.query<{ id: string; status: string; current_revision_no: number }>(
        `SELECT id, status, current_revision_no FROM bounty_submission WHERE id = $1 FOR UPDATE`,
        [submissionId],
      );
      if (!sub.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      if (!['SUBMITTED', 'RESUBMITTED', 'IN_REVIEW'].includes(sub.rows[0].status) && !(sub.rows[0].status === 'REVISION_REQUESTED' && decision === 'REJECT')) {
        throw new BadRequestException('SUBMISSION_NOT_REVIEWABLE');
      }
      if (revisionNo !== undefined && revisionNo !== sub.rows[0].current_revision_no) {
        throw new BadRequestException('SUBMISSION_REVISION_CHANGED');
      }
      if ((decision === 'REQUEST_REVISION' || (sub.rows[0].status === 'REVISION_REQUESTED' && decision === 'REJECT')) && !comment?.trim()) {
        throw new BadRequestException('REVISION_COMMENT_REQUIRED');
      }
      // 승인 수는 바운티의 max_winners를 넘을 수 없다 (바운티 행 잠금으로 동시 승인도 직렬화된다).
      if (decision === 'APPROVE') {
        const approved = await tx.query<{ count: string }>(
          `SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`,
          [parent.rows[0].id],
        );
        if (Number(approved.rows[0].count) >= Number(parent.rows[0].max_winners)) {
          throw new BadRequestException('MAX_WINNERS_REACHED');
        }
      }

      await tx.query(
        `UPDATE bounty_submission SET status = $2, reviewed_at = now() WHERE id = $1`,
        [submissionId, newStatus],
      );
      const rev = await tx.query<{ id: string }>(
        `SELECT id FROM submission_revision WHERE submission_id = $1 AND revision_no = $2`,
        [submissionId, sub.rows[0].current_revision_no],
      );
      await tx.query(
        `INSERT INTO submission_review (submission_id, revision_id, reviewer_id, decision, comment)
         VALUES ($1, $2, $3, $4, $5)`,
        [submissionId, rev.rows[0]?.id ?? null, adminId, decision, comment ?? null],
      );
      await this.audit.record(adminId, `SUBMISSION_${decision}`, 'bounty_submission', submissionId, tx);
      // APPROVE 시 후속 흐름(payout 요청 → NFT 민팅)은 rewards/nfts 모듈에서 별도 호출
      return { id: submissionId, status: newStatus };
    });
  }
}
