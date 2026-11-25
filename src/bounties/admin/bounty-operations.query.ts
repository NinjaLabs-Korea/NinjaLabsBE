import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../common/database/database.service';
import { evmAddressOf } from '../../common/validation/injective-address';
import { allowsPayoutSelfApproval, PAYOUT_ALLOW_SELF_APPROVAL_ENV } from '../../rewards/payout-approval';
import { allocatedPayoutSumSql, rewardCapSql } from '../../rewards/payout-status';
import { BountyStatusPolicy } from '../bounty-status';
import { BountyLifecycleService } from './bounty-lifecycle.service';

/** 운영 화면(FE /admin/operations) 읽기 모델 - 쓰기 명령은 BountyAdminService가 맡는다. */
@Injectable()
export class BountyOperationsQuery {
  constructor(
    private readonly db: DatabaseService,
    private readonly lifecycle: BountyLifecycleService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 운영 화면(FE /admin/operations) 한 번에 필요한 데이터 - Admin-only; never expose review notes or wallets publicly.
   *   applications / submissions: 신원(actor_kind 항상 'USER', user_id = 지원자, nickname, agent_id/agent_name은 항상 null: 에이전트 제거 후 FE 계약 호환 shim),
   *     submissions는 수상자가 입력한 지급 주소(payout_address 소문자 inj1, payout_address_evm 같은 바이트의 EIP-55 0x, payout_address_updated_at;
   *     없으면 null → payout 요청이 409 PAYOUT_ADDRESS_NOT_SET), recipient_wallet_address(= payout_address 별칭, deprecated: 옛 FE 운영 화면용, PR5에서 제거),
   *     email(APPROVED이고 소유자가 탈퇴하지 않은 제출만, 수상자 연락용. 나머지는 null),
   *     최신 리비전(current_revision_no + revisions[0]) - 심사 요청의 revisionNo 낙관적 검사에 그대로 쓴다.
   *   rewards: allocated_amount = 취소 아닌 payout 합계, cap = LEAST(amount, deposited_amount) (requestPayout과 같은 배정 상한)
   *   payouts: recipient_address(요청 시점 주소 스냅샷, 0029 이전 지갑 기반 행은 그 wallet 주소) + recipient_address_evm,
   *     requested_by/approved_by(+닉네임), requested_by_me (= 요청자가 지금 보는 운영자 → 2인 규칙상 승인 불가)
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
                owner.nickname AS actor_name,
                'USER' AS actor_kind,
                owner.id AS user_id, owner.nickname, NULL::uuid AS agent_id, NULL::text AS agent_name
           FROM bounty_application ap
           LEFT JOIN "user" owner ON owner.id = ap.applicant_user_id
          WHERE ap.bounty_id = $1 ORDER BY ap.applied_at DESC`, [bountyId]),
      this.db.query(
        `SELECT s.id, s.status, s.submission_url, s.description, s.repository_url, s.commit_sha,
                s.current_revision_no, s.submitted_at, s.last_resubmitted_at, s.reviewed_at,
                owner.nickname AS actor_name,
                'USER' AS actor_kind,
                owner.id AS user_id, owner.nickname, NULL::uuid AS agent_id, NULL::text AS agent_name,
                s.payout_address, s.payout_address_updated_at, s.payout_address AS recipient_wallet_address,
                CASE WHEN s.status = 'APPROVED' AND owner.deleted_at IS NULL THEN owner.email END AS email,
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
           LEFT JOIN "user" owner ON owner.id = s.submitter_user_id
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
                p.payout_tx_hash, COALESCE(p.recipient_address, w.address) AS recipient_address, rw.display_symbol,
                p.requested_by, req.nickname AS requested_by_nickname, p.requested_at,
                p.approved_by, appr.nickname AS approved_by_nickname, p.approved_at, p.paid_at,
                (p.requested_by = $2::uuid) IS TRUE AS requested_by_me
           FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
           LEFT JOIN wallet w ON w.id = p.recipient_wallet_id -- 0029 이전 지갑 기반 payout만 (새 payout은 recipient_wallet_id NULL)
           LEFT JOIN "user" req ON req.id = p.requested_by
           LEFT JOIN "user" appr ON appr.id = p.approved_by
          WHERE rw.bounty_id = $1 ORDER BY p.requested_at DESC`, [bountyId, viewerId ?? null]),
    ]);
    const row = bounty.rows[0] as { status: string; submission_deadline: string };
    const lifecycle = await this.lifecycle.blockers(this.db, bountyId, row);
    return {
      lifecycle: { ...lifecycle, allowedTransitions: BountyStatusPolicy.transitionsFrom(row.status) },
      bounty: row, applications: applications.rows,
      submissions: submissions.rows.map((s): Record<string, any> => ({ ...s, payout_address_evm: evmAddressOf(s.payout_address as string | null) })),
      rewards: rewards.rows,
      payouts: payouts.rows.map((p): Record<string, any> => ({ ...p, recipient_address_evm: evmAddressOf(p.recipient_address as string | null) })),
      policy: { payoutSelfApprovalAllowed: allowsPayoutSelfApproval(this.config.get<string>(PAYOUT_ALLOW_SELF_APPROVAL_ENV)) },
    };
  }
}
