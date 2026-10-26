import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueryResult } from 'pg';
import { AuditService } from '../audit/audit.service';
import { BountyStatusPolicy } from '../bounties/bounty-status';
import { DatabaseService, QueryRunner } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { TOKEN_AMOUNT } from '../common/validation/token-amount';
import { normalizeTxHash } from '../common/validation/tx-hash';
import { NftsService } from '../nfts/nfts.service';
import { allowsPayoutSelfApproval, PAYOUT_ALLOW_SELF_APPROVAL_ENV } from './payout-approval';
import {
  allocatedPayoutSumSql, AWAITING_APPROVAL_PAYOUT_STATUSES, PAYABLE_REWARD_STATUSES, rewardCapSql, SENDABLE_PAYOUT_STATUSES, sqlStatusList,
  UNSETTLED_PAYOUT_STATUSES,
} from './payout-status';

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
  private readonly logger = new Logger(RewardsService.name);
  private readonly allowSelfApproval: boolean;

  constructor(
    private readonly db: DatabaseService,
    private readonly nfts: NftsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.allowSelfApproval = allowsPayoutSelfApproval(config.get<string>(PAYOUT_ALLOW_SELF_APPROVAL_ENV));
    if (this.allowSelfApproval) {
      this.logger.warn(`${PAYOUT_ALLOW_SELF_APPROVAL_ENV}=true - the requesting admin may approve their own payouts (two-person rule disabled; each self-approval is audited as PAYOUT_SELF_APPROVED)`);
    }
  }

  /**
   * 운영자: 선입금 확인 처리 → 보상 FUNDED, 바운티 OPEN 전환은 admin 쪽에서.
   * tx 해시는 32바이트 hex만 받아 `0x`+소문자로 정규화한다 (400 INVALID_TX_HASH). 같은 해시를 두 보상에 쓰면
   * uq_bounty_reward_deposit_tx(0014)가 막고 409 TX_HASH_ALREADY_USED — 한 입금을 두 번 인정하지 않는다.
   * 이미 payout 송금으로 기록된 해시도 409 TX_HASH_ALREADY_USED (반대 방향 tx를 입금으로 인정하지 않는다).
   */
  async confirmDeposit(rewardId: string, txHash: string, depositedAmount: string, adminId: string) {
    this.validateAmount(depositedAmount);
    const hash = normalizeTxHash(txHash);
    return this.rejectReusedTxHash(() => this.db.tx(async (tx) => {
      // 같은 해시의 markPaid와 직렬화 (같은 advisory lock 키) — 입금 tx와 송금 tx는 방향이 반대라 같은 해시일 수 없다
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [hash]);
      const asPayout = await tx.query(`SELECT 1 FROM payout WHERE payout_tx_hash = $1 LIMIT 1`, [hash]);
      if (asPayout.rowCount || await this.isRecordedRefund(tx, hash)) throw new ConflictException('TX_HASH_ALREADY_USED');
      // 바운티 행 잠금 — 삭제(BountyAdminService.remove의 BOUNTY_HAS_OPEN_FUNDS 검사)와 직렬화하고, 삭제된 바운티의 입금은 받지 않는다
      const parent = await tx.query(`SELECT b.id FROM bounty b JOIN bounty_reward rw ON rw.bounty_id = b.id
        WHERE rw.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [rewardId]);
      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');
      const r = await tx.query(
        `UPDATE bounty_reward
            SET status = 'FUNDED', deposit_tx_hash = $2, deposited_amount = $3::numeric, deposited_at = now()
          WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND $3::numeric >= amount
          RETURNING id, bounty_id, status`,
        [rewardId, hash, depositedAmount],
      );
      if (!r.rowCount) {
        // 입금 대기 보상인데 금액이 모자란 경우는 "없거나 입금 대기가 아니다"가 아니라 금액 문제로 알려 준다 — 운영자가 금액을 고쳐 다시 보내면 된다
        const short = await tx.query(
          `SELECT 1 FROM bounty_reward WHERE id = $1 AND status = 'DEPOSIT_PENDING' AND amount > $2::numeric`,
          [rewardId, depositedAmount],
        );
        if (short.rowCount) throw new BadRequestException('DEPOSIT_BELOW_REWARD_AMOUNT');
        throw new NotFoundException('REWARD_NOT_FOUND_OR_NOT_PENDING');
      }
      await this.audit.record(adminId, 'REWARD_DEPOSIT_CONFIRMED', 'bounty_reward', rewardId, tx);
      return r.rows[0];
    }));
  }

  /**
   * 운영자: 승인된 제출물에 대한 지급 요청 생성 (멱등).
   * 배정 상한(2026-10-24 결정): 취소 아닌 payout 합계 + amount ≤ LEAST(게시 금액 amount, 입금액 deposited_amount) — 초과 입금은 상한을 올리지 않는다.
   * 보상이 이미 PAID여도 여유분(그 상한 − 취소 아닌 payout 합계)이 남아 있으면 받는다 — 첫 지급 뒤 운영자가 maxWinners를 올려
   * 수상자를 추가한 경우. 그때는 삽입 후 상태를 재계산해 PARTIALLY_PAID로 되돌린다 (advanceRewardStatus). 여유분이 없으면 400 PAYOUT_EXCEEDS_AVAILABLE_REWARD.
   */
  async requestPayout(rewardId: string, submissionId: string, amount: string, adminId: string) {
    this.validateAmount(amount);
    return this.db.tx(async (tx) => {
      const parent = await tx.query(`SELECT b.status FROM bounty b JOIN bounty_reward rw ON rw.bounty_id = b.id
        WHERE rw.id = $1 AND b.deleted_at IS NULL FOR UPDATE OF b`, [rewardId]);
      if (!parent.rowCount) throw new NotFoundException('REWARD_NOT_FOUND');
      if (!BountyStatusPolicy.isInProgress(parent.rows[0].status)) throw new BadRequestException('BOUNTY_REVIEW_CLOSED');
      // Serialize allocations against the same funded pool.
      const reward = await tx.query<{ bounty_id: string; status: string; cap: string }>(
        `SELECT rw.bounty_id, rw.status, ${rewardCapSql('rw')}::text AS cap FROM bounty_reward rw WHERE rw.id = $1 FOR UPDATE`,
        [rewardId],
      );
      if (!reward.rowCount || !(PAYABLE_REWARD_STATUSES as readonly string[]).includes(reward.rows[0].status)) {
        throw new BadRequestException('REWARD_NOT_FUNDED');
      }
      // 수령자 유저 행을 FOR SHARE로 잠근다 — 회원 탈퇴(AccountWithdrawalService)는 같은 행을 FOR UPDATE로 먼저 잠그고 열린 payout을
      // 검사하므로, 둘이 겹치면 한쪽이 기다린다: 탈퇴가 먼저면 이 조회가 재평가돼 탈퇴 유저(deleted_at) → 404, 이쪽이 먼저면 탈퇴가 이 payout을 보고 409.
      const wallet = await tx.query<{ wallet_id: string }>(
        `SELECT w.id AS wallet_id
           FROM bounty_submission s
           LEFT JOIN agent a ON a.id = s.agent_id
           JOIN "user" u ON u.id = COALESCE(s.submitter_user_id, a.owner_user_id)
                AND u.deleted_at IS NULL
           JOIN wallet w ON w.user_id = u.id
                AND w.is_primary = true AND w.disconnected_at IS NULL
          WHERE s.id = $1 AND s.status = 'APPROVED' AND s.bounty_id = $2
          FOR UPDATE OF s FOR SHARE OF u`,
        [submissionId, reward.rows[0].bounty_id],
      );
      if (!wallet.rowCount) throw new NotFoundException('APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND');
      const duplicate = await tx.query(`SELECT id FROM payout WHERE bounty_reward_id = $1 AND submission_id = $2`, [rewardId, submissionId]);
      if (duplicate.rowCount) throw new ConflictException('PAYOUT_ALREADY_REQUESTED');
      const allocated = await tx.query<{ amount: string }>(
        // 배정 합계 = 취소 아닌 payout 합계 (payout-status.ts ALLOCATED_PAYOUT_STATUSES)
        `SELECT ${allocatedPayoutSumSql('rw')}::text AS amount FROM bounty_reward rw WHERE rw.id = $1`, [rewardId],
      );
      if (BigInt(allocated.rows[0].amount) + BigInt(amount) > BigInt(reward.rows[0].cap)) {
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
      // 새 payout이 아직 지급 전이므로 PAID였던 보상은 PARTIALLY_PAID로 돌아간다 (FUNDED는 그대로 — 지급된 것이 없다)
      await this.advanceRewardStatus(tx, rewardId);
      await this.audit.record(adminId, 'PAYOUT_REQUESTED', 'payout', r.rows[0].id, tx);
      return r.rows[0];
    });
  }

  /**
   * 운영자: 멀티시그 승인 완료 표시 — 상태 전이와 감사 로그를 같은 트랜잭션에.
   * 2인 규칙: 요청한 운영자(requested_by)와 다른 운영자만 승인할 수 있다 → 같으면 403 PAYOUT_SELF_APPROVAL
   * (PAYOUT_ALLOW_SELF_APPROVAL=true면 허용 + warn + 감사 PAYOUT_SELF_APPROVED). rewards/payout-approval.ts
   */
  async markApproved(payoutId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const current = await tx.query<{ requested_by: string }>(
        `SELECT requested_by FROM payout
          WHERE id = $1 AND status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)}) FOR UPDATE`,
        [payoutId],
      );
      if (!current.rowCount) throw new NotFoundException('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
      const selfApproval = current.rows[0].requested_by === adminId;
      if (selfApproval && !this.allowSelfApproval) throw new ForbiddenException('PAYOUT_SELF_APPROVAL');
      const r = await tx.query(
        `UPDATE payout SET status = 'APPROVED', approved_by = $2, approved_at = now()
          WHERE id = $1 AND status IN (${sqlStatusList(AWAITING_APPROVAL_PAYOUT_STATUSES)})
          RETURNING id, status`,
        [payoutId, adminId],
      );
      if (!r.rowCount) throw new NotFoundException('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
      if (selfApproval) {
        this.logger.warn(`payout ${payoutId}: approved by the admin who requested it (${PAYOUT_ALLOW_SELF_APPROVAL_ENV}=true) - audited as PAYOUT_SELF_APPROVED`);
      }
      await this.audit.record(adminId, selfApproval ? 'PAYOUT_SELF_APPROVED' : 'PAYOUT_APPROVED', 'payout', payoutId, tx);
      return r.rows[0];
    });
  }

  /**
   * 운영자: 송금 완료 기록 (tx hash — confirmDeposit과 같은 정규화).
   * 멀티시그 tx 하나가 여러 수상자에게 한 번에 보낼 수 있으므로 **같은 바운티 안에서는** 같은 해시를 여러 payout에 기록할 수 있다(info 로그).
   * **다른 바운티**의 payout에 이미 PAID로 기록된 해시는 409 TX_HASH_ALREADY_USED — 한 송금을 두 바운티의 지급으로 인정하지 않는다.
   * 어느 보상의 입금 해시(deposit_tx_hash)로 기록된 값도 409 TX_HASH_ALREADY_USED.
   * payout_tx_hash에는 유니크 인덱스가 없으므로(0014는 정규화만) 이 검사는 UPDATE 전에 조회로 하고, 같은 해시의 동시 기록은
   * 해시별 advisory lock으로 직렬화한다.
   */
  async markPaid(payoutId: string, txHash: string, adminId: string) {
    const hash = normalizeTxHash(txHash);
    return this.db.tx(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [hash]);
      const target = await tx.query<{ bounty_id: string }>(
        `SELECT rw.bounty_id FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id WHERE p.id = $1 FOR UPDATE OF p`,
        [payoutId],
      );
      if (!target.rowCount) throw new NotFoundException('PAYOUT_NOT_FOUND_OR_WRONG_STATUS');
      const reuse = await tx.query<{ same_bounty: number; other_bounty: number }>(
        `SELECT count(*) FILTER (WHERE rw.bounty_id = $3::uuid)::int AS same_bounty,
                count(*) FILTER (WHERE rw.bounty_id <> $3::uuid)::int AS other_bounty
           FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
          WHERE p.payout_tx_hash = $2 AND p.status = 'PAID' AND p.id <> $1`,
        [payoutId, hash, target.rows[0].bounty_id],
      );
      if (reuse.rows[0].other_bounty > 0) throw new ConflictException('TX_HASH_ALREADY_USED');
      // 스폰서 입금(→ 멀티시그)이나 스폰서 환불(scripts/record-refund.js)로 이미 기록된 해시는 수상자 송금(멀티시그 →)의 증빙이 될 수 없다 — 운영자가 다른 용도의 해시를 잘못 붙여 넣는 실수를 막는다
      const asDeposit = await tx.query(`SELECT 1 FROM bounty_reward WHERE deposit_tx_hash = $1 LIMIT 1`, [hash]);
      if (asDeposit.rowCount || await this.isRecordedRefund(tx, hash)) throw new ConflictException('TX_HASH_ALREADY_USED');
      if (reuse.rows[0].same_bounty > 0) {
        this.logger.log(`payout ${payoutId}: tx ${hash} is already recorded on ${reuse.rows[0].same_bounty} PAID payout(s) of the same bounty - multi-recipient send`);
      }
      const payout = await tx.query<{
        id: string;
        status: string;
        payout_tx_hash: string;
        submission_id: string;
        recipient_wallet_id: string;
        bounty_reward_id: string;
      }>(
        `UPDATE payout SET status = 'PAID', payout_tx_hash = $2, paid_at = now()
          WHERE id = $1 AND status IN (${sqlStatusList(SENDABLE_PAYOUT_STATUSES)})
          RETURNING id, status, payout_tx_hash, submission_id, recipient_wallet_id, bounty_reward_id`,
        [payoutId, hash],
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
      await this.advanceRewardStatus(tx, payout.rows[0].bounty_reward_id);
      await this.audit.record(adminId, 'PAYOUT_PAID', 'payout', payoutId, tx);
      return payout.rows[0];
    });
  }

  /**
   * 이 해시가 환불 증빙(audit REWARD_REFUNDED의 txHash)으로 이미 기록됐나 — scripts/record-refund.js의 hashInUse와 반대 방향 검사.
   * 스크립트도 같은 해시별 advisory lock(hashtext)을 잡고 검사하므로 동시 기록이 서로를 본다. 호출자는 그 락을 먼저 잡아야 한다.
   */
  private async isRecordedRefund(tx: QueryRunner, hash: string): Promise<boolean> {
    const refund = (await tx.query(`SELECT 1 FROM audit_log WHERE action = 'REWARD_REFUNDED' AND after_data->>'txHash' = $1 LIMIT 1`, [hash])) as QueryResult;
    return Boolean(refund.rowCount);
  }

  /**
   * uq_bounty_reward_deposit_tx(0014) 충돌 → 409 TX_HASH_ALREADY_USED. confirmDeposit 전용 — 그 흐름에 다른 유니크 충돌은 없다.
   * payout 쪽은 유니크 인덱스가 없고 markPaid가 조회로 판단한다 (같은 바운티 재사용 허용).
   */
  private async rejectReusedTxHash<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err: unknown) {
      if (isUniqueViolation(err)) throw new ConflictException('TX_HASH_ALREADY_USED');
      throw err;
    }
  }

  /**
   * payout 변동 뒤 보상 상태 재계산 (markPaid / requestPayout 트랜잭션 안에서 호출). 지급된 payout이 하나라도 있어야 움직인다.
   *   PAID            — 미정산 payout(UNSETTLED_PAYOUT_STATUSES — 진행 중 + FAILED)이 없고, PAID 수가 max_winners에 도달했거나 PAID 합계가 배정 상한
   *                     LEAST(amount, deposited_amount)를 소진한 경우 (requestPayout과 같은 상한 — 초과 입금분은 여유분이 아니다)
   *   PARTIALLY_PAID  — 그 외: 잔액/수상자가 남았거나, 아직 지급 전인 payout이 있다 (PAID였다가 maxWinners 인상 후 payout이 추가된 경우 포함)
   *   FUNDED          — 지급된 것이 없으면 건드리지 않는다 (요청만 있는 상태는 "부분 지급"이 아니다)
   * 현재 상태에서 다시 계산하므로 몇 번 호출해도 결과가 같다.
   */
  private async advanceRewardStatus(tx: QueryRunner, rewardId: string) {
    // 동시 markPaid/requestPayout이 같은 reward를 갱신할 때 재계산이 상대 커밋을 본 뒤 실행되도록 먼저 잠근다.
    await tx.query(`SELECT id FROM bounty_reward WHERE id = $1 FOR UPDATE`, [rewardId]);
    await tx.query(
      `UPDATE bounty_reward rw
          SET status = CASE
                WHEN p.unsettled_count = 0 AND (p.paid_count >= b.max_winners OR p.paid_amount >= ${rewardCapSql('rw')}) THEN 'PAID'
                ELSE 'PARTIALLY_PAID'
              END
         FROM bounty b,
              (SELECT count(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
                      count(*) FILTER (WHERE status IN (${sqlStatusList(UNSETTLED_PAYOUT_STATUSES)}))::int AS unsettled_count,
                      COALESCE(SUM(amount) FILTER (WHERE status = 'PAID'), 0) AS paid_amount
                 FROM payout WHERE bounty_reward_id = $1) p
        WHERE rw.id = $1 AND b.id = rw.bounty_id
          AND rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})
          AND p.paid_count > 0`,
      [rewardId],
    );
  }

  private validateAmount(amount: string) {
    if (typeof amount !== 'string' || !TOKEN_AMOUNT.test(amount)) {
      throw new BadRequestException('INVALID_TOKEN_AMOUNT');
    }
  }
}
