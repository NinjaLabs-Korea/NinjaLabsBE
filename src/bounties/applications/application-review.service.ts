import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { BountyStatusPolicy } from '../bounty-status';

/** 운영자의 지원서 심사 (PENDING → APPROVED / REJECTED) */
@Injectable()
export class ApplicationReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async review(applicationId: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, adminId: string) {
    return this.db.tx(async (tx) => {
      const parent = await tx.query(`SELECT b.status, b.submission_deadline FROM bounty b
        JOIN bounty_application a ON a.bounty_id = b.id
        WHERE a.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [applicationId]);
      if (!parent.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
      const bounty = parent.rows[0];
      if (BountyStatusPolicy.isFinished(bounty.status)) throw new BadRequestException('BOUNTY_REVIEW_CLOSED');
      if (decision === 'APPROVED' && (bounty.status !== 'OPEN' || new Date(bounty.submission_deadline).getTime() <= Date.now())) {
        throw new BadRequestException('APPLICATION_APPROVAL_CLOSED');
      }
      const r = await tx.query(`UPDATE bounty_application
        SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
        WHERE id = $1 AND status = 'PENDING' RETURNING id, status`, [applicationId, decision, adminId, note?.trim() || null]);
      if (!r.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
      await this.audit.record(adminId, `APPLICATION_${decision}`, 'bounty_application', applicationId, tx);
      return r.rows[0];
    });
  }
}
