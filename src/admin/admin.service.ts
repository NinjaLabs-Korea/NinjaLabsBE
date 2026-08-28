import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class AdminService {
  constructor(private readonly db: DatabaseService) {}

  // ── 유저 관리 ──────────────────────────────────────────
  /** 이메일/닉네임으로 유저 검색 */
  async searchUsers(q: string) {
    const r = await this.db.query(
      `SELECT u.id, u.email, u.nickname, u.status, u.is_member, u.member_role,
              u.member_display_order, u.created_at, w.address AS wallet_address
         FROM "user" u
         LEFT JOIN wallet w ON w.user_id = u.id AND w.is_primary = true AND w.disconnected_at IS NULL
        WHERE u.deleted_at IS NULL
          AND (u.email ILIKE '%' || $1 || '%' OR u.nickname ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC
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
  async listBounties() {
    const r = await this.db.query(
      `SELECT b.*,
              COALESCE(json_agg(json_build_object(
                'symbol', rw.display_symbol, 'amount', rw.amount::text, 'tokenType', rw.token_type,
                'tokenContractAddress', rw.token_contract_address, 'evmChainId', rw.evm_chain_id
              )) FILTER (WHERE rw.id IS NOT NULL), '[]') AS rewards
         FROM bounty b
         LEFT JOIN bounty_reward rw ON rw.bounty_id = b.id
        WHERE b.deleted_at IS NULL
        GROUP BY b.id
        ORDER BY b.created_at DESC`,
    );
    return r.rows;
  }

  /** 바운티 등록 (DRAFT). 보상 정보 포함 시 bounty_reward 동시 생성 */
  async createBounty(adminId: string, input: {
    title: string; sponsorName: string; summary: string; description: string;
    requirements: string; evaluationCriteria: string; category: string;
    applicationRequired: boolean; maxWinners: number;
    submissionDeadline: string; applicationDeadline?: string;
    reward?: { tokenType: string; tokenDenom?: string; tokenContractAddress?: string; evmChainId?: number; displaySymbol: string; amount: string };
  }) {
    const configuredUsdcAddress = process.env.USDC_EVM_CONTRACT_ADDRESS;
    const configuredEvmChainId = Number(process.env.INJECTIVE_EVM_CHAIN_ID);
    const isUsdc = input.reward?.displaySymbol.toUpperCase() === 'USDC';
    if (isUsdc && (!configuredUsdcAddress || !/^0x[0-9a-fA-F]{40}$/.test(configuredUsdcAddress))) {
      throw new BadRequestException('USDC_EVM_CONTRACT_NOT_CONFIGURED');
    }
    if (isUsdc && ![1439, 1776].includes(configuredEvmChainId)) {
      throw new BadRequestException('INJECTIVE_EVM_CHAIN_NOT_CONFIGURED');
    }
    const reward = input.reward ? (isUsdc ? {
      ...input.reward,
      tokenType: 'ERC20',
      tokenDenom: `erc20:${configuredUsdcAddress!.toLowerCase()}`,
      tokenContractAddress: configuredUsdcAddress,
      evmChainId: configuredEvmChainId,
    } : input.reward) : undefined;
    if (reward?.tokenType === 'NATIVE' && !reward.tokenDenom) {
      throw new BadRequestException('REWARD_TOKEN_DENOM_REQUIRED');
    }
    if (reward?.tokenType === 'CW20' && !reward.tokenContractAddress) {
      throw new BadRequestException('REWARD_TOKEN_CONTRACT_REQUIRED');
    }
    if (reward?.tokenType === 'ERC20' && (!reward.tokenContractAddress || !reward.evmChainId)) {
      throw new BadRequestException('REWARD_EVM_METADATA_REQUIRED');
    }
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

      if (reward) {
        await tx.query(
          `INSERT INTO bounty_reward
             (bounty_id, token_type, token_denom, token_contract_address, evm_chain_id,
              display_symbol, amount, custody_address)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [bountyId, reward.tokenType, reward.tokenDenom ?? null,
           reward.tokenContractAddress ?? null, reward.evmChainId ?? null,
           reward.displaySymbol, reward.amount,
           process.env.REWARD_MULTISIG_ADDRESS ?? 'PENDING_MULTISIG_SETUP'],
        );
        // 보상이 있으면 선입금 대기 상태로
        await tx.query(`UPDATE bounty SET status = 'FUNDING_PENDING' WHERE id = $1`, [bountyId]);
      }

      await this.audit(adminId, 'BOUNTY_CREATED', 'bounty', bountyId, tx);
      return { id: bountyId };
    });
  }

  async updateBounty(bountyId: string, input: {
    title?: string; sponsorName?: string; summary?: string; description?: string;
    requirements?: string; evaluationCriteria?: string; category?: string;
    applicationRequired?: boolean; maxWinners?: number; submissionDeadline?: string;
    applicationDeadline?: string | null;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['title', input.title], ['sponsor_name', input.sponsorName], ['summary', input.summary],
      ['description', input.description], ['requirements', input.requirements],
      ['evaluation_criteria', input.evaluationCriteria], ['category', input.category],
      ['application_required', input.applicationRequired], ['max_winners', input.maxWinners],
      ['submission_deadline', input.submissionDeadline], ['application_deadline', input.applicationDeadline],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (!fields.length) return { id: bountyId };
    const values = fields.map(([, value]) => value);
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE bounty SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
      [bountyId, ...values],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    await this.audit(adminId, 'BOUNTY_UPDATED', 'bounty', bountyId);
    return r.rows[0];
  }

  async deleteBounty(bountyId: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE bounty SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [bountyId],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    await this.audit(adminId, 'BOUNTY_DELETED', 'bounty', bountyId);
    return r.rows[0];
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
  async listNotices() {
    const r = await this.db.query(
      `SELECT id, title, summary, body, category, thumbnail_url, external_url,
              status, published_at, created_at
         FROM notice WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows;
  }

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

  async updateNotice(noticeId: string, input: {
    title?: string; summary?: string; body?: string; category?: string;
    thumbnailUrl?: string; externalUrl?: string; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['title', input.title], ['summary', input.summary], ['body', input.body],
      ['category', input.category], ['thumbnail_url', input.thumbnailUrl], ['external_url', input.externalUrl],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (input.publish !== undefined) {
      fields.push(['status', input.publish ? 'PUBLISHED' : 'DRAFT']);
      fields.push(['published_at', input.publish ? new Date() : null]);
    }
    if (!fields.length) return { id: noticeId };
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE notice SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
      [noticeId, ...fields.map(([, value]) => value)],
    );
    if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
    await this.audit(adminId, 'NOTICE_UPDATED', 'notice', noticeId);
    return r.rows[0];
  }

  async deleteNotice(noticeId: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE notice SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [noticeId],
    );
    if (!r.rowCount) throw new NotFoundException('NOTICE_NOT_FOUND');
    await this.audit(adminId, 'NOTICE_DELETED', 'notice', noticeId);
    return r.rows[0];
  }

  // ── Hall of Fame 하이라이트 관리 ───────────────────────
  async listHighlights() {
    const r = await this.db.query(
      `SELECT id, type, title, description, image_url, link_url, bounty_id,
              display_order, is_published, published_at
         FROM platform_highlight ORDER BY display_order, created_at DESC`,
    );
    return r.rows;
  }

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

  async updateHighlight(highlightId: string, input: {
    type?: string; title?: string; description?: string; imageUrl?: string;
    linkUrl?: string; displayOrder?: number; publish?: boolean;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['type', input.type], ['title', input.title], ['description', input.description],
      ['image_url', input.imageUrl], ['link_url', input.linkUrl], ['display_order', input.displayOrder],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (input.publish !== undefined) {
      fields.push(['is_published', input.publish]);
      fields.push(['published_at', input.publish ? new Date() : null]);
    }
    if (!fields.length) return { id: highlightId };
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE platform_highlight SET ${assignments} WHERE id = $1 RETURNING id, is_published`,
      [highlightId, ...fields.map(([, value]) => value)],
    );
    if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
    await this.audit(adminId, 'HIGHLIGHT_UPDATED', 'platform_highlight', highlightId);
    return r.rows[0];
  }

  async deleteHighlight(highlightId: string, adminId: string) {
    const r = await this.db.query(`DELETE FROM platform_highlight WHERE id = $1 RETURNING id`, [highlightId]);
    if (!r.rowCount) throw new NotFoundException('HIGHLIGHT_NOT_FOUND');
    await this.audit(adminId, 'HIGHLIGHT_DELETED', 'platform_highlight', highlightId);
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
