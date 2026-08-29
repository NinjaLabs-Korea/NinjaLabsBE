import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';

/**
 * 지원형 바운티(application_required = true) 참가 신청
 * 상태 흐름: PENDING → APPROVED / REJECTED (본인 철회 시 WITHDRAWN)
 */
@Injectable()
export class ApplicationsService {
  constructor(private readonly db: DatabaseService) {}

  async apply(bountyId: string, userId: string, message: string, portfolioUrl?: string) {
    return this.applyForActor(bountyId, { userId }, message, portfolioUrl);
  }

  async applyAsAgent(bountyId: string, agentId: string, message: string, portfolioUrl?: string) {
    return this.applyForActor(bountyId, { agentId }, message, portfolioUrl);
  }

  private async applyForActor(
    bountyId: string,
    actor: { userId: string } | { agentId: string },
    message: string,
    portfolioUrl?: string,
  ) {
    const bounty = await this.db.query<{
      application_required: boolean;
      submission_mode: string;
      status: string;
    }>(
      `SELECT application_required, submission_mode, status FROM bounty
        WHERE id = $1 AND deleted_at IS NULL`,
      [bountyId],
    );
    if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    if (!bounty.rows[0].application_required) {
      throw new BadRequestException('SUBMISSION_TYPE_BOUNTY'); // 제출형은 바로 제출
    }
    if (bounty.rows[0].status !== 'OPEN') {
      throw new BadRequestException('BOUNTY_NOT_OPEN');
    }
    const isAgent = 'agentId' in actor;
    if (bounty.rows[0].submission_mode === 'AGENT' && !isAgent) {
      throw new BadRequestException('AGENT_SUBMISSION_REQUIRED');
    }
    if (bounty.rows[0].submission_mode === 'DIRECT' && isAgent) {
      throw new BadRequestException('DIRECT_SUBMISSION_REQUIRED');
    }

    try {
      const r = await this.db.query(
        `INSERT INTO bounty_application
           (bounty_id, applicant_user_id, agent_id, message, portfolio_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, status, applied_at`,
        [bountyId, isAgent ? null : actor.userId, isAgent ? actor.agentId : null,
         message, portfolioUrl ?? null],
      );
      return r.rows[0];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('ALREADY_APPLIED');
      }
      throw err;
    }
  }

  /** 내 지원 내역 */
  async myApplications(userId: string) {
    const r = await this.db.query(
      `SELECT a.id, a.status, a.message, a.applied_at, a.reviewed_at,
              b.id AS bounty_id, b.title AS bounty_title, b.category
         FROM bounty_application a
         JOIN bounty b ON b.id = a.bounty_id
        WHERE a.applicant_user_id = $1
        ORDER BY a.applied_at DESC`,
      [userId],
    );
    return r.rows;
  }

  /** 지원 철회 */
  async withdraw(applicationId: string, userId: string) {
    const r = await this.db.query(
      `UPDATE bounty_application SET status = 'WITHDRAWN'
        WHERE id = $1 AND applicant_user_id = $2 AND status = 'PENDING'
        RETURNING id, status`,
      [applicationId, userId],
    );
    if (!r.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
    return r.rows[0];
  }
}
