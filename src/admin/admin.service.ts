import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService) {}

  // ── 유저 관리 ──────────────────────────────────────────
  /** 이메일/닉네임으로 유저 검색 */
  async searchUsers(q: string) {
    const r = await this.db.query(
      `SELECT id, email, nickname, status, is_member, member_role, created_at
         FROM "user"
        WHERE deleted_at IS NULL
          AND (email ILIKE '%' || $1 || '%' OR nickname ILIKE '%' || $1 || '%')
        ORDER BY created_at DESC
        LIMIT 30`,
      [q],
    );
    return r.rows;
  }

  /** 멤버 지정/해제 + 역할/노출순서 */
  async setMember(userId: string, isMember: boolean, role?: string, displayOrder?: number, adminId?: string) {
    const r = await this.db.query(
      `UPDATE "user"
          SET is_member = $2,
              member_role = CASE WHEN $2 THEN $3::varchar ELSE NULL END,
              member_display_order = CASE WHEN $2 THEN $4::integer ELSE NULL END
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, nickname, is_member, member_role`,
      [userId, isMember, role ?? null, displayOrder ?? null],
    );
    if (!r.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    await this.audit(adminId, isMember ? 'USER_MEMBER_GRANTED' : 'USER_MEMBER_REVOKED', 'user', userId);
    return r.rows[0];
  }

  // ── 바운티 관리 ────────────────────────────────────────
  /** 바운티 등록 (DRAFT). 보상 정보 포함 시 bounty_reward 동시 생성 */
  async createBounty(adminId: string, input: {
    title: string; sponsorName: string; summary: string; description: string;
    requirements: string; evaluationCriteria: string; category: string;
    applicationRequired: boolean; maxWinners: number;
    submissionDeadline: string; applicationDeadline?: string;
    reward?: { tokenType: string; tokenDenom?: string; tokenContractAddress?: string; displaySymbol: string; amount: string };
  }) {
    return this.db.tx(async (tx) => {
      const b = await tx.query<{ id: string }>(
        `INSERT INTO bounty
           (created_by, sponsor_name, title, summary, description, requirements,
            evaluation_criteria, category, application_required, max_winners,
            submission_deadline, application_deadline)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [adminId, input.sponsorName, input.title, input.summary, input.description,
         input.requirements, input.evaluationCriteria, input.category,
         input.applicationRequired, input.maxWinners,
         input.submissionDeadline, input.applicationDeadline ?? null],
      );
      const bountyId = b.rows[0].id;

      if (input.reward) {
        await tx.query(
          `INSERT INTO bounty_reward
             (bounty_id, token_type, token_denom, token_contract_address, display_symbol, amount, custody_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [bountyId, input.reward.tokenType, input.reward.tokenDenom ?? null,
           input.reward.tokenContractAddress ?? null, input.reward.displaySymbol,
           input.reward.amount, process.env.REWARD_MULTISIG_ADDRESS ?? 'PENDING_MULTISIG_SETUP'],
        );
        // 보상이 있으면 선입금 대기 상태로
        await tx.query(`UPDATE bounty SET status = 'FUNDING_PENDING' WHERE id = $1`, [bountyId]);
      }

      await this.audit(adminId, 'BOUNTY_CREATED', 'bounty', bountyId, tx);
      return { id: bountyId };
    });
  }

  /** 바운티 상태 전환 (허용된 전이만) */
  async transitionBounty(bountyId: string, to: string, adminId: string) {
    const allowed: Record<string, string[]> = {
      DRAFT: ['FUNDING_PENDING', 'OPEN', 'CANCELLED'],
      FUNDING_PENDING: ['OPEN', 'CANCELLED'],
      OPEN: ['SUBMISSION_CLOSED', 'CANCELLED'],
      SUBMISSION_CLOSED: ['IN_REVIEW'],
      IN_REVIEW: ['COMPLETED'],
    };
    const cur = await this.db.query<{ status: string }>(
      `SELECT status FROM bounty WHERE id = $1 AND deleted_at IS NULL`,
      [bountyId],
    );
    if (!cur.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    const from = cur.rows[0].status;
    if (!allowed[from]?.includes(to)) {
      throw new NotFoundException(`INVALID_TRANSITION:${from}->${to}`);
    }
    const stamp: Record<string, string> = {
      OPEN: 'opened_at',
      IN_REVIEW: 'review_started_at',
      COMPLETED: 'completed_at',
    };
    const stampCol = stamp[to] ? `, ${stamp[to]} = now()` : '';
    await this.db.query(
      `UPDATE bounty SET status = $2${stampCol} WHERE id = $1`,
      [bountyId, to],
    );
    await this.audit(adminId, `BOUNTY_${to}`, 'bounty', bountyId);
    return { id: bountyId, status: to };
  }

  // ── 지원서 심사 ────────────────────────────────────────
  async reviewApplication(applicationId: string, decision: 'APPROVED' | 'REJECTED', note: string | undefined, adminId: string) {
    const r = await this.db.query(
      `UPDATE bounty_application
          SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
        WHERE id = $1 AND status = 'PENDING'
        RETURNING id, status`,
      [applicationId, decision, adminId, note ?? null],
    );
    if (!r.rowCount) throw new NotFoundException('APPLICATION_NOT_FOUND_OR_NOT_PENDING');
    await this.audit(adminId, `APPLICATION_${decision}`, 'bounty_application', applicationId);
    return r.rows[0];
  }

  // ── 제출물 심사 ────────────────────────────────────────
  async reviewSubmission(submissionId: string, decision: string, comment: string | undefined, adminId: string) {
    const statusMap: Record<string, string> = {
      START_REVIEW: 'IN_REVIEW',
      REQUEST_REVISION: 'REVISION_REQUESTED',
      APPROVE: 'APPROVED',
      REJECT: 'REJECTED',
    };
    const newStatus = statusMap[decision];
    if (!newStatus) throw new NotFoundException('INVALID_DECISION');

    return this.db.tx(async (tx) => {
      const sub = await tx.query<{ id: string; current_revision_no: number }>(
        `SELECT id, current_revision_no FROM bounty_submission WHERE id = $1 FOR UPDATE`,
        [submissionId],
      );
      if (!sub.rowCount) throw new NotFoundException('SUBMISSION_NOT_FOUND');

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
      await this.audit(adminId, `SUBMISSION_${decision}`, 'bounty_submission', submissionId, tx);
      // APPROVE 시 후속 흐름(payout 요청 → NFT 민팅)은 rewards/nfts 모듈에서 별도 호출
      return { id: submissionId, status: newStatus };
    });
  }

  // ── 공지 관리 ──────────────────────────────────────────
  async createNotice(adminId: string, input: {
    title: string; summary?: string; body: string; category: string;
    thumbnailUrl?: string; externalUrl?: string; publish?: boolean;
  }) {
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO notice (created_by, title, summary, body, category, thumbnail_url, external_url, status, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [adminId, input.title, input.summary ?? null, input.body, input.category,
       input.thumbnailUrl ?? null, input.externalUrl ?? null,
       input.publish ? 'PUBLISHED' : 'DRAFT',
       input.publish ? new Date() : null],
    );
    await this.audit(adminId, input.publish ? 'NOTICE_PUBLISHED' : 'NOTICE_CREATED', 'notice', r.rows[0].id);
    return r.rows[0];
  }

  // ── Hall of Fame 하이라이트 관리 ───────────────────────
  async createHighlight(adminId: string, input: {
    type: string; title: string; description: string;
    imageUrl?: string; linkUrl?: string; bountyId?: string;
    displayOrder?: number; publish?: boolean;
  }) {
    const r = await this.db.query<{ id: string }>(
      `INSERT INTO platform_highlight
         (created_by, type, title, description, image_url, link_url, bounty_id, display_order, is_published, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [adminId, input.type, input.title, input.description,
       input.imageUrl ?? null, input.linkUrl ?? null, input.bountyId ?? null,
       input.displayOrder ?? 0, input.publish ?? false,
       input.publish ? new Date() : null],
    );
    await this.audit(adminId, 'HIGHLIGHT_CREATED', 'platform_highlight', r.rows[0].id);
    return r.rows[0];
  }

  // ── 감사 로그 헬퍼 ─────────────────────────────────────
  private async audit(
    actorId: string | undefined,
    action: string,
    entityType: string,
    entityId: string,
    tx?: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  ) {
    const runner = tx ?? this.db;
    await runner.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [actorId ?? null, action, entityType, entityId],
    );
  }
}
