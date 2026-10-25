import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service';
import { DatabaseService } from '../../common/database/database.service';
import { OPEN_PAYOUT_STATUSES, PAYABLE_REWARD_STATUSES, rewardHoldsFundsSql, sqlStatusList } from '../../rewards/payout-status';
import { BountyStatusPolicy } from '../bounty-status';
import { BountyLifecycleService } from './bounty-lifecycle.service';
import { RewardInput, RewardTokenResolver } from './reward-token.resolver';

/** 저장된 마감과 이 차이 미만이면 "바꾸지 않은 값" — FE의 datetime-local 입력은 초/밀리초를 보존하지 못한다 */
const DEADLINE_UNCHANGED_TOLERANCE_MS = 60_000;

/** 운영자용 바운티 관리 — 등록/수정/삭제/상태 전이 (쓰기 명령). 운영 현황 조회는 BountyOperationsQuery.
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

  /** 바운티 등록 (DRAFT). 보상 정보 포함 시 bounty_reward 동시 생성 */
  async create(adminId: string, input: {
    title: string; sponsorName: string; summary: string; description: string;
    requirements: string; evaluationCriteria: string; category: string;
    applicationRequired: boolean; submissionMode: string; maxWinners: number;
    submissionDeadline: string; applicationDeadline?: string;
    coverImageUrl?: string;
    reward?: RewardInput;
  }) {
    // 수정(update)과 같은 규칙: 새 바운티의 마감은 미래여야 한다 — 과거 마감으로 만들면 DRAFT에서 열 수도(DEADLINE_PASSED) 접수할 수도 없는 행이 생긴다
    for (const deadline of [input.submissionDeadline, input.applicationDeadline]) {
      if (deadline && !(new Date(deadline).getTime() > Date.now())) throw new BadRequestException('DEADLINE_IN_PAST');
    }
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
    if (!fields.length) {
      // 바꿀 필드가 없어도 없는/삭제된 바운티는 404 (빈 PATCH가 존재하지 않는 id에 200을 주지 않게)
      const exists = await this.db.query(`SELECT 1 FROM bounty WHERE id = $1 AND deleted_at IS NULL`, [bountyId]);
      if (!exists.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
      return { id: bountyId };
    }
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
   * 삭제 정책(2026-10-24 결정, 2026-10-25 개정 — docs/decisions.md): 멀티시그에 아직 묶인 돈이 있으면 409 BOUNTY_HAS_OPEN_FUNDS —
   *   - 보상이 REFUND_PENDING이거나, FUNDED/PARTIALLY_PAID/PAID인데 입금액(deposited_amount) − PAID 합계 > 0
   *     (배정 상한 LEAST(amount, deposited)가 아니라 입금액 전체 — 초과 입금분도 돌려줘야 할 돈이다. 정산 = REFUNDED, 또는 입금액을 전부 지급)
   *   - 또는 종료 상태(PAID/CANCELLED/FAILED)가 아닌(= 진행 중) payout이 하나라도 있음
   *   상태 집합·비교식은 rewards/payout-status.ts (OPEN_PAYOUT_STATUSES, PAYABLE_REWARD_STATUSES, rewardHoldsFundsSql)
   * 허용: 보상이 DEPOSIT_PENDING/REFUNDED/CANCELLED이거나 입금액 전액이 지급된 PAID뿐인 바운티. 남은 돈은 CANCELLED → scripts/record-refund.js(REFUNDED)로
   * 정산한다 — 환불 스크립트는 CANCELLED 바운티만 받으므로, 전액 지급됐지만 초과 입금분이 남은 COMPLETED 바운티는 삭제할 수 없다(409, runbook §7.7).
   * 검사는 바운티 행 잠금 아래에서 하므로 같은 바운티의 requestPayout/confirmDeposit(둘 다 바운티 행을 먼저 잠근다)과 직렬화된다.
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
                    OR (rw.status IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})
                        AND ${rewardHoldsFundsSql('rw', 'p')}))) AS open_rewards,
           (SELECT count(*)::int FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
             WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS open_payouts`,
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
