import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { payoutStatusSql } from '../../rewards/payout-status';
import { BountyActor } from '../bounty-actor';
import { BountyStatus, BountyStatusPolicy } from '../bounty-status';
import { SubmissionStatus, SubmissionStatusPolicy } from '../submission-status';

export interface SubmitInput {
  submissionUrl: string;
  description: string;
  repositoryUrl?: string;
  commitSha?: string;
}

/**
 * 제출 정책 (ERD §9)
 * - 제출자당 제출 레코드 1개(최신본) + submission_revision 스냅샷
 * - 지원형 바운티는 APPROVED 지원서가 있어야 제출 가능
 * - 마감 전 자유 수정, 마감 후엔 REVISION_REQUESTED 상태에서만 재제출
 * 제출 상태 규칙(재제출 가능·확정)의 단일 출처는 bounties/submission-status.ts
 */
@Injectable()
export class SubmissionsService {
  constructor(private readonly db: DatabaseService) {}

  async submit(bountyId: string, userId: string, input: SubmitInput) {
    return this.submitForActor(bountyId, BountyActor.user(userId), input);
  }

  async submitAsAgent(bountyId: string, agentId: string, input: SubmitInput) {
    return this.submitForActor(bountyId, BountyActor.agent(agentId), input);
  }

  private async submitForActor(
    bountyId: string,
    actor: BountyActor,
    input: SubmitInput,
  ) {
    return this.db.tx(async (tx) => {
      const bounty = await tx.query<{
        application_required: boolean;
        submission_mode: string;
        status: string;
        submission_deadline: Date;
      }>(
        `SELECT application_required, submission_mode, status, submission_deadline
           FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [bountyId],
      );
      if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      const b = bounty.rows[0];
      if (!BountyStatusPolicy.isInProgress(b.status)) throw new BadRequestException('BOUNTY_NOT_OPEN');
      actor.assertAllowedBy(b.submission_mode);

      // 지원형: 승인된 지원서 필요
      let applicationId: string | null = null;
      if (b.application_required) {
        const app = await tx.query<{ id: string }>(
          `SELECT id FROM bounty_application
            WHERE bounty_id = $1
              AND ${actor.applicationColumn} = $2
              AND status = 'APPROVED'`,
          [bountyId, actor.id],
        );
        if (!app.rowCount) throw new ForbiddenException('APPLICATION_NOT_APPROVED');
        applicationId = app.rows[0].id;
      }

      // upsert: 기존 제출이 있으면 리비전 증가, 없으면 신규
      const existing = await tx.query<{ id: string; status: string; current_revision_no: number }>(
        `SELECT id, status, current_revision_no FROM bounty_submission
          WHERE bounty_id = $1
            AND ${actor.submissionColumn} = $2 FOR UPDATE`,
        [bountyId, actor.id],
      );

      const deadlinePassed = new Date(b.submission_deadline) < new Date();

      if (!existing.rowCount) {
        if (b.status !== BountyStatus.OPEN) throw new BadRequestException('BOUNTY_NOT_OPEN');
        if (deadlinePassed) throw new BadRequestException('DEADLINE_PASSED');
        const created = await tx.query<{ id: string }>(
          `INSERT INTO bounty_submission
             (bounty_id, application_id, submitter_user_id, agent_id,
              submission_url, description, repository_url, commit_sha)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [bountyId, applicationId, actor.userId,
           actor.agentId, input.submissionUrl, input.description,
           input.repositoryUrl ?? null, input.commitSha ?? null],
        );
        const submissionId = created.rows[0].id;
        await tx.query(
          `INSERT INTO submission_revision
             (submission_id, revision_no, submission_url, description, repository_url,
              commit_sha, created_by_user_id, created_by_agent_id)
           VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
          [submissionId, input.submissionUrl, input.description,
           input.repositoryUrl ?? null, input.commitSha ?? null,
           actor.userId, actor.agentId],
        );
        return { id: submissionId, revisionNo: 1, status: SubmissionStatus.SUBMITTED };
      }

      const sub = existing.rows[0];
      const resubmitAfterClose = SubmissionStatusPolicy.canResubmitAfterIntakeClosed(sub.status);
      if (b.status !== BountyStatus.OPEN && !resubmitAfterClose) {
        throw new BadRequestException('BOUNTY_NOT_OPEN');
      }
      // 마감 후에는 REVISION_REQUESTED 상태에서만 재제출 허용
      if (deadlinePassed && !resubmitAfterClose) {
        throw new BadRequestException('DEADLINE_PASSED');
      }
      // 승인/거절 확정 후에는 수정 불가
      if (SubmissionStatusPolicy.isFinalized(sub.status)) {
        throw new ConflictException('SUBMISSION_FINALIZED');
      }

      const nextRev = sub.current_revision_no + 1;
      await tx.query(
        `UPDATE bounty_submission
            SET submission_url = $2, description = $3, repository_url = $4, commit_sha = $5,
                status = 'RESUBMITTED', current_revision_no = $6, last_resubmitted_at = now()
          WHERE id = $1`,
        [sub.id, input.submissionUrl, input.description,
         input.repositoryUrl ?? null, input.commitSha ?? null, nextRev],
      );
      await tx.query(
        `INSERT INTO submission_revision
           (submission_id, revision_no, submission_url, description, repository_url,
            commit_sha, created_by_user_id, created_by_agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sub.id, nextRev, input.submissionUrl, input.description,
         input.repositoryUrl ?? null, input.commitSha ?? null,
         actor.userId, actor.agentId],
      );
      return { id: sub.id, revisionNo: nextRev, status: SubmissionStatus.RESUBMITTED };
    });
  }

  /**
   * 내 제출 내역 — 본인 제출 + 내가 소유한 에이전트의 제출. 각 행에 agent {id, name} | null.
   * payment_status는 rewards/payout-status.ts payoutStatusSql(공개 프로필 payoutStatus와 같은 SQL)인데, 그 식은 **승인된 제출** 전용이다 —
   * APPROVED가 아닌 제출(심사 중·반려·scripts/forfeit-award.js로 몰수된 수상)은 받을 몫이 없으므로 'NONE'으로 고정한다.
   * (식을 그대로 쓰면 여유분이 남은 입금 보상이 있는 동안 반려된 제출도 'PENDING' — "지급 대기"로 보인다.)
   */
  async mySubmissions(userId: string) {
    const r = await this.db.query(
      `SELECT s.id, s.status, s.current_revision_no, s.submitted_at, s.last_resubmitted_at,
              b.id AS bounty_id, b.title AS bounty_title, b.category,
              CASE WHEN ag.id IS NULL THEN NULL
                   ELSE json_build_object('id', ag.id, 'name', ag.name) END AS agent,
              CASE WHEN s.status = 'APPROVED' THEN ${payoutStatusSql('s', 'b')} ELSE 'NONE' END AS payment_status, s.description,
              review.comment AS review_comment
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL -- 삭제된 바운티는 공개 프로필·상세와 같이 없는 것으로 본다 (링크가 404가 된다)
         LEFT JOIN agent ag ON ag.id = s.agent_id
         LEFT JOIN LATERAL (SELECT comment FROM submission_review WHERE submission_id = s.id
                            ORDER BY created_at DESC LIMIT 1) review ON true
        WHERE s.submitter_user_id = $1
           OR s.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL))
        ORDER BY s.submitted_at DESC`,
      [userId],
    );
    return r.rows;
  }
}
