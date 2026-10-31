import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../common/database/database.service';
import { allowsPayoutSelfApproval, PAYOUT_ALLOW_SELF_APPROVAL_ENV } from '../../rewards/payout-approval';
import { allocatedPayoutSumSql, rewardCapSql } from '../../rewards/payout-status';
import { BountyStatusPolicy } from '../bounty-status';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { primaryWalletSql } from '../../wallets/primary-wallet';

/** 운영 화면(FE /admin/operations) 읽기 모델 — 쓰기 명령은 BountyAdminService가 맡는다. */
@Injectable()
export class BountyOperationsQuery {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: BountyLifecycleService,
    private readonly config: ConfigService,
  ) {}

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
  async execute(bountyId: string, viewerId?: string) {
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
                (SELECT w.address FROM wallet w WHERE w.user_id = owner.id AND ${primaryWalletSql('w')}
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
                ${rewardCapSql('rw')}::text AS cap,
                ${allocatedPayoutSumSql('rw', 'p')}::text AS allocated_amount
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
}
