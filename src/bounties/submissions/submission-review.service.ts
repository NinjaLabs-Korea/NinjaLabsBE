import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { BountyStatusPolicy } from '../bounty-status';
import { SubmissionDecision, SubmissionStatusPolicy } from '../submission-status';
import { recordReviews } from './system-review';

/** 운영자의 제출물 심사 — 심사 시작/수정 요청/승인/반려와 리비전별 심사 기록 */
@Injectable()
export class SubmissionReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async review(submissionId: string, decision: string, comment: string | undefined, adminId: string, revisionNo?: number) {
    // 결정 → 상태, 심사 가능 상태, 코멘트 필수 규칙은 모두 bounties/submission-status.ts
    const newStatus = SubmissionStatusPolicy.statusAfter(decision);
    if (!newStatus) throw new NotFoundException('INVALID_DECISION');

    return this.db.tx(async (tx) => {
      const parent = await tx.query(`SELECT b.id, b.status, b.max_winners FROM bounty b JOIN bounty_submission s ON s.bounty_id = b.id
        WHERE s.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [submissionId]);
      if (!parent.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      if (!BountyStatusPolicy.isInProgress(parent.rows[0].status)) throw new BadRequestException('BOUNTY_REVIEW_CLOSED');
      // 승인은 제출자(에이전트 제출이면 소유자)의 유저 행을 FOR SHARE로 잠그고 활성 상태를 확인한다. 회원 탈퇴(AccountWithdrawalService)는 같은 행을
      // FOR UPDATE로 먼저 잠그므로 둘이 겹치면 한쪽이 기다린다: 탈퇴가 먼저면 여기서 USER_NOT_FOUND, 이쪽이 먼저면 탈퇴가 이 승인을 보고 막힌다.
      // 없으면 지급 불가능한 APPROVED 제출이 winner 자리를 차지한다. 제출 행 잠금보다 먼저 잡아 탈퇴(유저 행 -> 제출 행)와 잠금 순서를 맞춘다 (requestPayout과 같은 패턴).
      if (decision === SubmissionDecision.APPROVE) {
        const submitter = await tx.query(
          `SELECT u.id FROM bounty_submission s
             LEFT JOIN agent a ON a.id = s.agent_id
             JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id)
                  AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
            WHERE s.id = $1
            FOR SHARE OF u`,
          [submissionId],
        );
        if (!submitter.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      }
      const sub = await tx.query<{ id: string; status: string; current_revision_no: number }>(
        `SELECT id, status, current_revision_no FROM bounty_submission WHERE id = $1 FOR UPDATE`,
        [submissionId],
      );
      if (!sub.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');
      if (!SubmissionStatusPolicy.canReview(sub.rows[0].status, decision)) {
        throw new BadRequestException('SUBMISSION_NOT_REVIEWABLE');
      }
      if (revisionNo !== undefined && revisionNo !== sub.rows[0].current_revision_no) {
        throw new BadRequestException('SUBMISSION_REVISION_CHANGED');
      }
      if (SubmissionStatusPolicy.requiresComment(sub.rows[0].status, decision) && !comment?.trim()) {
        throw new BadRequestException('REVISION_COMMENT_REQUIRED');
      }
      // 승인 수는 바운티의 max_winners를 넘을 수 없다 (바운티 행 잠금으로 동시 승인도 직렬화된다).
      if (decision === SubmissionDecision.APPROVE) {
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
      await recordReviews(tx, [submissionId], adminId, decision as SubmissionDecision, comment?.trim() || null);
      await this.audit.record(adminId, `SUBMISSION_${decision}`, 'bounty_submission', submissionId, tx);
      // APPROVE 시 후속 흐름(payout 요청 → NFT 민팅)은 rewards/nfts 모듈에서 별도 호출
      return { id: submissionId, status: newStatus };
    });
  }
}
