import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { BountyStatusPolicy } from '../bounty-status';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardInput, RewardTokenResolver } from './reward-token.resolver';

/** 운영자용 바운티 관리 — 등록/수정/삭제/상태 전이와 운영 현황 조회.
 * 전이 가능 여부는 BountyStatusPolicy, 전이 차단 사유는 BountyLifecycleService가 결정한다. */
@Injectable()
export class BountyAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly lifecycle: BountyLifecycleService,
    private readonly rewardTokens: RewardTokenResolver,
  ) {}

  async list() {
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

  /** Admin-only operational data; never expose review notes or wallets publicly. */
  async operations(bountyId: string) {
    const bounty = await this.db.query(
      `SELECT id, title, status, submission_deadline, application_deadline FROM bounty WHERE id = $1 AND deleted_at IS NULL`, [bountyId],
    );
    if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    const [applications, submissions, rewards, payouts] = await Promise.all([
      this.db.query(
        `SELECT ap.id, ap.status, ap.message, ap.portfolio_url, ap.review_note, ap.applied_at,
                COALESCE(a.name, u.nickname) AS actor_name
           FROM bounty_application ap
           LEFT JOIN "user" u ON u.id = ap.applicant_user_id
           LEFT JOIN agent a ON a.id = ap.agent_id
          WHERE ap.bounty_id = $1 ORDER BY ap.applied_at DESC`, [bountyId]),
      this.db.query(
        `SELECT s.id, s.status, s.submission_url, s.description, s.repository_url, s.commit_sha,
                s.current_revision_no, s.submitted_at, COALESCE(a.name, u.nickname) AS actor_name,
                review.comment AS review_comment,
                COALESCE((SELECT json_agg(json_build_object('revision_no', r.revision_no,
                  'submission_url', r.submission_url, 'description', r.description,
                  'repository_url', r.repository_url, 'commit_sha', r.commit_sha, 'created_at', r.created_at)
                  ORDER BY r.revision_no DESC) FROM submission_revision r WHERE r.submission_id = s.id), '[]') AS revisions,
                COALESCE((SELECT json_agg(json_build_object('revision_no', r.revision_no,
                  'decision', v.decision, 'comment', v.comment, 'created_at', v.created_at)
                  ORDER BY v.created_at DESC) FROM submission_review v LEFT JOIN submission_revision r ON r.id = v.revision_id
                  WHERE v.submission_id = s.id), '[]') AS reviews
           FROM bounty_submission s
           LEFT JOIN "user" u ON u.id = s.submitter_user_id
           LEFT JOIN agent a ON a.id = s.agent_id
           LEFT JOIN LATERAL (SELECT comment FROM submission_review WHERE submission_id = s.id
                              ORDER BY created_at DESC LIMIT 1) review ON true
          WHERE s.bounty_id = $1 ORDER BY s.submitted_at DESC`, [bountyId]),
      this.db.query(
        `SELECT id, status, display_symbol, amount::text, deposited_amount::text,
                custody_address, deposit_tx_hash, token_contract_address, evm_chain_id
           FROM bounty_reward WHERE bounty_id = $1 ORDER BY created_at`, [bountyId]),
      this.db.query(
        `SELECT p.id, p.bounty_reward_id, p.submission_id, p.status, p.amount::text,
                p.payout_tx_hash, w.address AS recipient_address, rw.display_symbol
           FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
           JOIN wallet w ON w.id = p.recipient_wallet_id
          WHERE rw.bounty_id = $1 ORDER BY p.requested_at DESC`, [bountyId]),
    ]);
    return { lifecycle: await this.lifecycle.blockers(this.db, bountyId, bounty.rows[0] as { status: string; submission_deadline: string }), bounty: bounty.rows[0], applications: applications.rows, submissions: submissions.rows,
      rewards: rewards.rows, payouts: payouts.rows };
  }

  /** 바운티 등록 (DRAFT). 보상 정보 포함 시 bounty_reward 동시 생성 */
  async create(adminId: string, input: {
    title: string; sponsorName: string; summary: string; description: string;
    requirements: string; evaluationCriteria: string; category: string;
    applicationRequired: boolean; submissionMode: string; maxWinners: number;
    submissionDeadline: string; applicationDeadline?: string;
    coverImageUrl?: string;
    reward?: RewardInput;
  }) {
    const reward = this.rewardTokens.resolve(input.reward);
    return this.db.tx(async (tx) => {
      const b = await tx.query<{ id: string }>(
        `INSERT INTO bounty
           (created_by, sponsor_name, title, summary, description, requirements,
            evaluation_criteria, category, application_required, max_winners,
            submission_deadline, application_deadline, cover_image_url, submission_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [adminId, input.sponsorName, input.title, input.summary, input.description,
         input.requirements, input.evaluationCriteria, input.category,
         input.applicationRequired, input.maxWinners,
         input.submissionDeadline, input.applicationDeadline ?? null,
         input.coverImageUrl ?? null, input.submissionMode],
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
           this.rewardTokens.custodyAddress()],
        );
        // 보상이 있으면 선입금 대기 상태로
        await tx.query(`UPDATE bounty SET status = 'FUNDING_PENDING' WHERE id = $1`, [bountyId]);
      }

      await this.audit.record(adminId, 'BOUNTY_CREATED', 'bounty', bountyId, tx);
      return { id: bountyId };
    });
  }

  async update(bountyId: string, input: {
    title?: string; sponsorName?: string; summary?: string; description?: string;
    requirements?: string; evaluationCriteria?: string; category?: string;
    applicationRequired?: boolean; submissionMode?: string; maxWinners?: number;
    submissionDeadline?: string; applicationDeadline?: string | null;
    coverImageUrl?: string | null;
  }, adminId: string) {
    const fields: Array<[string, unknown]> = [
      ['title', input.title], ['sponsor_name', input.sponsorName], ['summary', input.summary],
      ['description', input.description], ['requirements', input.requirements],
      ['evaluation_criteria', input.evaluationCriteria], ['category', input.category],
      ['application_required', input.applicationRequired], ['max_winners', input.maxWinners],
      ['submission_deadline', input.submissionDeadline], ['application_deadline', input.applicationDeadline],
      ['submission_mode', input.submissionMode], ['cover_image_url', input.coverImageUrl],
    ].filter((entry) => entry[1] !== undefined) as Array<[string, unknown]>;
    if (!fields.length) return { id: bountyId };
    const values = fields.map(([, value]) => value);
    const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
    const r = await this.db.query(
      `UPDATE bounty SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
      [bountyId, ...values],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    await this.audit.record(adminId, 'BOUNTY_UPDATED', 'bounty', bountyId);
    return r.rows[0];
  }

  async remove(bountyId: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE bounty SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [bountyId],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    await this.audit.record(adminId, 'BOUNTY_DELETED', 'bounty', bountyId);
    return r.rows[0];
  }

  async transition(bountyId: string, to: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const cur = await tx.query(`SELECT status, submission_deadline FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [bountyId]);
      if (!cur.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      const from = cur.rows[0].status;
      if (!BountyStatusPolicy.canTransition(from, to)) throw new BadRequestException(`INVALID_TRANSITION:${from}->${to}`);
      const { blockers } = await this.lifecycle.blockers(tx, bountyId, cur.rows[0] as { status: string });
      if (blockers[to]?.length) throw new BadRequestException(blockers[to]);
      const stamp = BountyStatusPolicy.stampColumnFor(to);
      const stampCol = stamp ? `, ${stamp} = COALESCE(${stamp}, now())` : '';
      await tx.query(`UPDATE bounty SET status = $2${stampCol} WHERE id = $1`, [bountyId, to]);
      await this.audit.record(adminId, `BOUNTY_${to}`, 'bounty', bountyId, tx);
      return { id: bountyId, status: to };
    });
  }
}
