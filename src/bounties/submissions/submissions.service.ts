import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';

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
 */
@Injectable()
export class SubmissionsService {
  constructor(private readonly db: DatabaseService) {}

  async submit(bountyId: string, userId: string, input: SubmitInput) {
    return this.submitForActor(bountyId, { userId }, input);
  }

  async submitAsAgent(bountyId: string, agentId: string, input: SubmitInput) {
    return this.submitForActor(bountyId, { agentId }, input);
  }

  private async submitForActor(
    bountyId: string,
    actor: { userId: string } | { agentId: string },
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
      if (b.status !== 'OPEN') throw new BadRequestException('BOUNTY_NOT_OPEN');
      const isAgent = 'agentId' in actor;
      if (b.submission_mode === 'AGENT' && !isAgent) {
        throw new BadRequestException('AGENT_SUBMISSION_REQUIRED');
      }
      if (b.submission_mode === 'DIRECT' && isAgent) {
        throw new BadRequestException('DIRECT_SUBMISSION_REQUIRED');
      }

      // 지원형: 승인된 지원서 필요
      let applicationId: string | null = null;
      if (b.application_required) {
        const app = await tx.query<{ id: string }>(
          `SELECT id FROM bounty_application
            WHERE bounty_id = $1
              AND ${isAgent ? 'agent_id' : 'applicant_user_id'} = $2
              AND status = 'APPROVED'`,
          [bountyId, isAgent ? actor.agentId : actor.userId],
        );
        if (!app.rowCount) throw new ForbiddenException('APPLICATION_NOT_APPROVED');
        applicationId = app.rows[0].id;
      }

      // upsert: 기존 제출이 있으면 리비전 증가, 없으면 신규
      const existing = await tx.query<{ id: string; status: string; current_revision_no: number }>(
        `SELECT id, status, current_revision_no FROM bounty_submission
          WHERE bounty_id = $1
            AND ${isAgent ? 'agent_id' : 'submitter_user_id'} = $2 FOR UPDATE`,
        [bountyId, isAgent ? actor.agentId : actor.userId],
      );

      const deadlinePassed = new Date(b.submission_deadline) < new Date();

      if (!existing.rowCount) {
        if (deadlinePassed) throw new BadRequestException('DEADLINE_PASSED');
        const created = await tx.query<{ id: string }>(
          `INSERT INTO bounty_submission
             (bounty_id, application_id, submitter_user_id, agent_id,
              submission_url, description, repository_url, commit_sha)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [bountyId, applicationId, isAgent ? null : actor.userId,
           isAgent ? actor.agentId : null, input.submissionUrl, input.description,
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
           isAgent ? null : actor.userId, isAgent ? actor.agentId : null],
        );
        return { id: submissionId, revisionNo: 1, status: 'SUBMITTED' };
      }

      const sub = existing.rows[0];
      // 마감 후에는 REVISION_REQUESTED 상태에서만 재제출 허용
      if (deadlinePassed && sub.status !== 'REVISION_REQUESTED') {
        throw new BadRequestException('DEADLINE_PASSED');
      }
      // 승인/거절 확정 후에는 수정 불가
      if (['APPROVED', 'REJECTED'].includes(sub.status)) {
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
         isAgent ? null : actor.userId, isAgent ? actor.agentId : null],
      );
      return { id: sub.id, revisionNo: nextRev, status: 'RESUBMITTED' };
    });
  }

  /** 내 제출 내역 */
  async mySubmissions(userId: string) {
    const r = await this.db.query(
      `SELECT s.id, s.status, s.current_revision_no, s.submitted_at, s.last_resubmitted_at,
              b.id AS bounty_id, b.title AS bounty_title
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id
        WHERE s.submitter_user_id = $1
        ORDER BY s.submitted_at DESC`,
      [userId],
    );
    return r.rows;
  }
}
