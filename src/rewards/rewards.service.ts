import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { NftsService } from '../nfts/nfts.service';

/**
 * MVP 보상 흐름 (ERD §10)
 *   스폰서 선입금(멀티시그) → 운영자 입금 확인 → 바운티 OPEN
 *   → 심사/승인 → payout 요청 → 멀티시그 승인 → 송금 → tx hash 기록
 *
 * 멀티시그 서명 자체는 오프체인(운영자 수동)이고,
 * 시스템은 상태·멱등성·기록을 책임진다.
 */
@Injectable()
export class RewardsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nfts: NftsService,
  ) {}

  /** 운영자: 선입금 확인 처리 → 보상 FUNDED, 바운티 OPEN 전환은 admin 쪽에서 */
  async confirmDeposit(rewardId: string, txHash: string, depositedAmount: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE bounty_reward
          SET status = 'FUNDED', deposit_tx_hash = $2, deposited_amount = $3, deposited_at = now()
        WHERE id = $1 AND status = 'DEPOSIT_PENDING'
        RETURNING id, bounty_id, status`,
      [rewardId, txHash, depositedAmount],
    );
    if (!r.rowCount) throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');
    await this.audit(adminId, 'REWARD_DEPOSIT_CONFIRMED', 'bounty_reward', rewardId);
    return r.rows[0];
  }

  /** 운영자: 승인된 제출물에 대한 지급 요청 생성 (멱등) */
  async requestPayout(rewardId: string, submissionId: string, amount: string, adminId: string) {
    const wallet = await this.db.query<{ wallet_id: string }>(
      `SELECT w.id AS wallet_id
         FROM bounty_submission s
         LEFT JOIN agent a ON a.id = s.agent_id
         JOIN wallet w ON w.user_id = COALESCE(s.submitter_user_id, a.owner_user_id)
              AND w.is_primary = true AND w.disconnected_at IS NULL
        WHERE s.id = $1 AND s.status = 'APPROVED'`,
      [submissionId],
    );
    if (!wallet.rowCount) {
      // 지갑 미연결 유저 — 기획 원칙상 이 시점에 지갑 연결 재유도
      throw new NotFoundException('APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND');
    }

    const idempotencyKey = `submission:${submissionId}:reward:${rewardId}`;
    try {
      const r = await this.db.query(
        `INSERT INTO payout
           (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, status, requested_at`,
        [rewardId, submissionId, wallet.rows[0].wallet_id, amount, idempotencyKey, adminId],
      );
      await this.audit(adminId, 'PAYOUT_REQUESTED', 'payout', r.rows[0].id);
      return r.rows[0];
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('PAYOUT_ALREADY_REQUESTED');
      }
      throw err;
    }
  }

  /** 운영자: 멀티시그 승인 완료 표시 */
  async markApproved(payoutId: string, adminId: string) {
    const r = await this.db.query(
      `UPDATE payout SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE id = $1 AND status IN ('REQUESTED', 'AWAITING_MULTISIG_APPROVAL')
        RETURNING id, status`,
      [payoutId, adminId],
    );
    if (!r.rowCount) throw new NotFoundException('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
    await this.audit(adminId, 'PAYOUT_APPROVED', 'payout', payoutId);
    return r.rows[0];
  }

  /** 운영자: 송금 완료 기록 (tx hash) */
  async markPaid(payoutId: string, txHash: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const payout = await tx.query<{
        id: string;
        status: string;
        payout_tx_hash: string;
        submission_id: string;
        recipient_wallet_id: string;
      }>(
        `UPDATE payout SET status = 'PAID', payout_tx_hash = $2, paid_at = now()
          WHERE id = $1 AND status IN ('APPROVED', 'BROADCASTING')
          RETURNING id, status, payout_tx_hash, submission_id, recipient_wallet_id`,
        [payoutId, txHash],
      );
      if (!payout.rowCount) throw new NotFoundException('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');

      const submission = await tx.query<{ owner_user_id: string; bounty_id: string }>(
        `SELECT COALESCE(s.submitter_user_id, a.owner_user_id) AS owner_user_id,
                s.bounty_id
           FROM bounty_submission s
           LEFT JOIN agent a ON a.id = s.agent_id
          WHERE s.id = $1 AND s.status = 'APPROVED'`,
        [payout.rows[0].submission_id],
      );
      if (!submission.rowCount || !submission.rows[0].owner_user_id) {
        throw new NotFoundException('APPROVED_SUBMISSION_NOT_FOUND');
      }

      await this.nfts.enqueueChildMintInTransaction(
        tx,
        submission.rows[0].owner_user_id,
        payout.rows[0].recipient_wallet_id,
        submission.rows[0].bounty_id,
        payout.rows[0].submission_id,
      );
      await tx.query(
        `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
         VALUES ($1, 'PAYOUT_PAID', 'payout', $2)`,
        [adminId, payoutId],
      );
      return payout.rows[0];
    });
  }

  private async audit(actorId: string, action: string, entityType: string, entityId: string) {
    await this.db.query(
      `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4)`,
      [actorId, action, entityType, entityId],
    );
  }
}
