import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BountyStatusPolicy } from '../bounties/bounty-status';
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
    private readonly audit: AuditService,
  ) {}

  /** 운영자: 선입금 확인 처리 → 보상 FUNDED, 바운티 OPEN 전환은 admin 쪽에서 */
  async confirmDeposit(rewardId: string, txHash: string, depositedAmount: string, adminId: string) {
    this.validateAmount(depositedAmount);
    const r = await this.db.query(
      `UPDATE bounty_reward
          SET status = 'FUNDED', deposit_tx_hash = $2, deposited_amount = $3, deposited_at = now()
        WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric >= amount
        RETURNING id, bounty_id, status`,
      [rewardId, txHash, depositedAmount],
    );
    if (!r.rowCount) throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');
    await this.audit.record(adminId, 'REWARD_DEPOSIT_CONFIRMED', 'bounty_reward', rewardId);
    return r.rows[0];
  }

  /** 운영자: 승인된 제출물에 대한 지급 요청 생성 (멱등) */
  async requestPayout(rewardId: string, submissionId: string, amount: string, adminId: string) {
    this.validateAmount(amount);
    return this.db.tx(async (tx) => {
      const parent = await tx.query(`SELECT b.status FROM bounty b JOIN bounty_reward rw ON rw.bounty_id = b.id
        WHERE rw.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [rewardId]);
      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND');
      if (!BountyStatusPolicy.isInProgress(parent.rows[0].status)) throw new BadRequestException('BOUNTY_REVIEW_CLOSED');
      // Serialize allocations against the same funded pool.
      const reward = await tx.query<{ bounty_id: string; status: string; deposited_amount: string }>(
        `SELECT bounty_id, status, deposited_amount::text FROM bounty_reward WHERE id = $1 FOR UPDATE`,
        [rewardId],
      );
      if (!reward.rowCount || !['FUNDED', 'PARTIALLY_PAID'].includes(reward.rows[0].status)) {
        throw new BadRequestException('REWARD_NOT_FUNDED');
      }
      const wallet = await tx.query<{ wallet_id: string }>(
        `SELECT w.id AS wallet_id
           FROM bounty_submission s
           LEFT JOIN agent a ON a.id = s.agent_id
           JOIN wallet w ON w.user_id = COALESCE(s.submitter_user_id, a.owner_user_id)
                AND w.is_primary = true AND w.disconnected_at IS NULL
          WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2 FOR UPDATE OF s`,
        [submissionId, reward.rows[0].bounty_id],
      );
      if (!wallet.rowCount) throw new NotFoundException('APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND');
      const duplicate = await tx.query(`SELECT id FROM payout WHERE bounty_reward_id = $1 AND submission_id = $2`, [rewardId, submissionId]);
      if (duplicate.rowCount) throw new ConflictException('PAYOUT_ALREADY_REQUESTED');
      const allocated = await tx.query<{ amount: string }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS amount FROM payout
          WHERE bounty_reward_id = $1 AND status <> 'CANCELLED'`, [rewardId],
      );
      if (BigInt(allocated.rows[0].amount) + BigInt(amount) > BigInt(reward.rows[0].deposited_amount)) {
        throw new BadRequestException('PAYOUT_EXCEEDS_AVAILABLE_REWARD');
      }
      const r = await tx.query(
        `INSERT INTO payout
           (bounty_reward_id, submission_id, recipient_wallet_id, amount, idempotency_key, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, status, requested_at`,
        [rewardId, submissionId, wallet.rows[0].wallet_id, amount,
         `submission:${submissionId}:reward:${rewardId}`, adminId],
      );
      await this.audit.record(adminId, 'PAYOUT_REQUESTED', 'payout', r.rows[0].id, tx);
      return r.rows[0];
    });
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
    await this.audit.record(adminId, 'PAYOUT_APPROVED', 'payout', payoutId);
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
      await this.audit.record(adminId, 'PAYOUT_PAID', 'payout', payoutId, tx);
      return payout.rows[0];
    });
  }

  private validateAmount(amount: string) {
    if (typeof amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(amount)) {
      throw new BadRequestException('INVALID_TOKEN_AMOUNT');
    }
  }
}
