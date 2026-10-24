import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { allowsPayoutSelfApproval, PAYOUT_ALLOW_SELF_APPROVAL_ENV } from '../../rewards/payout-approval';
import { BountyStatusPolicy } from '../bounty-status';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardInput, RewardTokenResolver } from './reward-token.resolver';

/** 저장된 마감과 이 차이 미만이면 "바꾸지 않은 값" — FE의 datetime-local 입력은 초/밀리초를 보존하지 못한다 */
const DEADLINE_UNCHANGED_TOLERANCE_MS = 60_000;

/** 운영자용 바운티 관리 — 등록/수정/삭제/상태 전이와 운영 현황 조회.
 * 전이 가능 여부는 BountyStatusPolicy, 전이 차단 사유는 BountyLifecycleService가 결정한다. */
@Injectable()
export class BountyAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly lifecycle: BountyLifecycleService,
    private readonly rewardTokens: RewardTokenResolver,
    private readonly config: ConfigService,
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

  /**
   * 운영 화면(FE /admin/operations) 한 번에 필요한 데이터 — Admin-only; never expose review notes or wallets publicly.
   *   applications / submissions: 신원(actor_kind USER|AGENT, user_id = 지원자 또는 에이전트 소유자, nickname, agent_id/agent_name),
   *     submissions는 지급 받을 지갑(recipient_wallet_address: 소유자의 활성 primary 지갑, 없으면 null → payout 요청이 404)과
   *     최신 리비전(current_revision_no + revisions[0]) — 심사 요청의 revisionNo 낙관적 검사에 그대로 쓴다.
   *   rewards: allocated_amount = 취소 아닌 payout 합계, cap = LEAST(amount, deposited_amount) (requestPayout과 같은 배정 상한)
   *   payouts: requested_by/approved_by(+닉네임), requested_by_me (= 요청자가 지금 보는 운영자 → 2인 규칙상 승인 불가)
   *   lifecycle: blockers(영문, 전이 400 본문과 같음) + blockerDetails(코드) + allowedTransitions(BountyStatusPolicy 전이표)
   *   policy.payoutSelfApprovalAllowed: PAYOUT_ALLOW_SELF_APPROVAL (rewards/payout-approval.ts)
   */
  async operations(bountyId: string, viewerId?: string) {
    const bounty = await this.db.query(
      `SELECT id, title, status, submission_deadline, application_deadline, max_winners, application_required, submission_mode
         FROM bounty WHERE id = $1 AND deleted_at IS NULL`, [bountyId],
    );
    if (!bounty.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    const [applications, submissions, rewards, payouts] = await Promise.all([
      this.db.query(
        `SELECT ap.id, ap.status, ap.message, ap.portfolio_url, ap.review_note, ap.applied_at, ap.reviewed_at,
                COALESCE(a.name, u.nickname) AS actor_name,
                CASE WHEN ap.agent_id IS NULL THEN 'USER' ELSE 'AGENT' END AS actor_kind,
                owner.id AS user_id, owner.nickname, ap.agent_id, a.name AS agent_name
           FROM bounty_application ap
           LEFT JOIN "user" u ON u.id = ap.applicant_user_id
           LEFT JOIN agent a ON a.id = ap.agent_id
           LEFT JOIN "user" owner ON owner.id = COALESCE(ap.applicant_user_id, a.owner_user_id)
          WHERE ap.bounty_id = $1 ORDER BY ap.applied_at DESC`, [bountyId]),
      this.db.query(
        `SELECT s.id, s.status, s.submission_url, s.description, s.repository_url, s.commit_sha,
                s.current_revision_no, s.submitted_at, s.last_resubmitted_at, s.reviewed_at,
                COALESCE(a.name, u.nickname) AS actor_name,
                CASE WHEN s.agent_id IS NULL THEN 'USER' ELSE 'AGENT' END AS actor_kind,
                owner.id AS user_id, owner.nickname, s.agent_id, a.name AS agent_name,
                (SELECT w.address FROM wallet w WHERE w.user_id = owner.id AND w.is_primary = true AND w.disconnected_at IS NULL
                  LIMIT 1) AS recipient_wallet_address,
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
           LEFT JOIN "user" owner ON owner.id = COALESCE(s.submitter_user_id, a.owner_user_id)
           LEFT JOIN LATERAL (SELECT comment FROM submission_review WHERE submission_id = s.id
                              ORDER BY created_at DESC LIMIT 1) review ON true
          WHERE s.bounty_id = $1 ORDER BY s.submitted_at DESC`, [bountyId]),
      this.db.query(
        `SELECT rw.id, rw.status, rw.token_type, rw.display_symbol, rw.amount::text, rw.deposited_amount::text, rw.deposited_at,
                rw.custody_address, rw.deposit_tx_hash, rw.token_contract_address, rw.evm_chain_id,
                LEAST(rw.amount, rw.deposited_amount)::text AS cap,
                (SELECT COALESCE(SUM(p.amount), 0)::text FROM payout p
                  WHERE p.bounty_reward_id = rw.id AND p.status <> 'CANCELLED') AS allocated_amount
           FROM bounty_reward rw WHERE rw.bounty_id = $1 ORDER BY rw.created_at`, [bountyId]),
      this.db.query(
        `SELECT p.id, p.bounty_reward_id, p.submission_id, p.status, p.amount::text,
                p.payout_tx_hash, w.address AS recipient_address, rw.display_symbol,
                p.requested_by, req.nickname AS requested_by_nickname, p.requested_at,
                p.approved_by, appr.nickname AS approved_by_nickname, p.approved_at, p.paid_at,
                (p.requested_by = $2::uuid) IS TRUE AS requested_by_me
           FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
           JOIN wallet w ON w.id = p.recipient_wallet_id
           LEFT JOIN "user" req ON req.id = p.requested_by
           LEFT JOIN "user" appr ON appr.id = p.approved_by
          WHERE rw.bounty_id = $1 ORDER BY p.requested_at DESC`, [bountyId, viewerId ?? null]),
    ]);
    const row = bounty.rows[0] as { status: string; submission_deadline: string };
    const lifecycle = await this.lifecycle.blockers(this.db, bountyId, row);
    return {
      lifecycle: { ...lifecycle, allowedTransitions: BountyStatusPolicy.transitionsFrom(row.status) },
      bounty: row, applications: applications.rows, submissions: submissions.rows,
      rewards: rewards.rows, payouts: payouts.rows,
      policy: { payoutSelfApprovalAllowed: allowsPayoutSelfApproval(this.config.get<string>(PAYOUT_ALLOW_SELF_APPROVAL_ENV)) },
    };
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
    return this.db.tx(async (tx) => {
      // 승인 수 확인과 max_winners 변경 사이에 APPROVE가 끼어들지 않도록 바운티 행을 잠근다 (심사도 같은 행을 잠근다)
      const cur = await tx.query<{ id: string; status: string; submission_deadline: string | Date; application_deadline: string | Date | null }>(
        `SELECT id, status, submission_deadline, application_deadline FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [bountyId],
      );
      if (!cur.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      // 마감은 과거로 "옮길" 수 없다 — FE는 수정 때마다 기존 마감을 그대로 되보내므로, 저장된 값과 같은 과거 마감은 통과시킨다
      // (null로 지우는 것도 허용). FE가 datetime-local로 왕복시키며 초/밀리초를 잃으므로 1분 미만 차이는 "같은 값"으로 본다.
      // 접수가 끝난 상태(SUBMISSION_CLOSED/IN_REVIEW/COMPLETED/CANCELLED)에서는 마감이 더 이상 의미 없으므로 검사하지 않는다 —
      // 지난 마감을 그대로 둔 채 제목/설명만 고칠 수 있어야 한다.
      if (BountyStatusPolicy.enforcesFutureDeadline(cur.rows[0].status)) {
        for (const [deadline, stored] of [
          [input.submissionDeadline, cur.rows[0].submission_deadline],
          [input.applicationDeadline, cur.rows[0].application_deadline],
        ] as const) {
          if (!deadline) continue;
          const next = new Date(deadline).getTime();
          const unchanged = stored !== null && Math.abs(next - new Date(stored).getTime()) < DEADLINE_UNCHANGED_TOLERANCE_MS;
          if (!unchanged && !(next > Date.now())) throw new BadRequestException('DEADLINE_IN_PAST');
        }
      }
      if (input.maxWinners !== undefined) {
        const approved = await tx.query<{ count: string }>(
          `SELECT count(*) FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`,
          [bountyId],
        );
        if (input.maxWinners < Number(approved.rows[0].count)) {
          throw new BadRequestException('MAX_WINNERS_BELOW_APPROVED');
        }
      }
      const r = await tx.query(
        `UPDATE bounty SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING id, status`,
        [bountyId, ...values],
      );
      if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      await this.audit.record(adminId, 'BOUNTY_UPDATED', 'bounty', bountyId, tx);
      return r.rows[0];
    });
  }

  /**
   * soft delete + 감사 로그를 **같은 트랜잭션**에 — 감사 기록이 실패하면 삭제도 롤백된다 (다른 *-admin 서비스와 같은 규칙).
   * 삭제 정책(2026-10-24 결정, docs/decisions.md): 멀티시그에 아직 묶인 돈이 있으면 409 BOUNTY_HAS_OPEN_FUNDS —
   *   - 보상이 REFUND_PENDING이거나, FUNDED/PARTIALLY_PAID/PAID인데 PAID 합계가 배정 상한 LEAST(amount, deposited_amount)에 못 미침
   *   - 또는 종료 상태(PAID/CANCELLED/FAILED)가 아닌 payout이 하나라도 있음
   * 허용: 보상이 DEPOSIT_PENDING/REFUNDED/CANCELLED이거나 전액 지급된 PAID뿐인 바운티. 검사는 바운티 행 잠금 아래에서 하므로
   * 같은 바운티의 requestPayout/confirmDeposit(둘 다 바운티 행을 먼저 잠근다)과 직렬화된다.
   */
  async remove(bountyId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const locked = await tx.query(`SELECT id FROM bounty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [bountyId]);
      if (!locked.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      const open = await tx.query<{ open_rewards: number; open_payouts: number }>(
        `SELECT
           (SELECT count(*)::int FROM bounty_reward rw
             WHERE rw.bounty_id = $1
               AND (rw.status = 'REFUND_PENDING'
                    OR (rw.status IN ('FUNDED', 'PARTIALLY_PAID', 'PAID')
                        AND LEAST(rw.amount, rw.deposited_amount) >
                            (SELECT COALESCE(SUM(p.amount), 0) FROM payout p WHERE p.bounty_reward_id = rw.id AND p.status = 'PAID')))) AS open_rewards,
           (SELECT count(*)::int FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
             WHERE rw.bounty_id = $1 AND p.status NOT IN ('PAID', 'CANCELLED', 'FAILED')) AS open_payouts`,
        [bountyId],
      );
      if (open.rows[0].open_rewards > 0 || open.rows[0].open_payouts > 0) throw new ConflictException('BOUNTY_HAS_OPEN_FUNDS');
      const r = await tx.query(
        `UPDATE bounty SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
        [bountyId],
      );
      if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      await this.audit.record(adminId, 'BOUNTY_DELETED', 'bounty', bountyId, tx);
      return r.rows[0];
    });
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
