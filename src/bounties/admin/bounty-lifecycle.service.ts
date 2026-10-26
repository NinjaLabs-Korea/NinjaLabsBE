import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { OPEN_PAYOUT_STATUSES, owesUnpaidRewardSql, PAYABLE_REWARD_STATUSES, sqlStatusList } from '../../rewards/payout-status';
import { SubmissionStatusPolicy } from '../submission-status';

/** 전이 차단 사유 코드 — 운영 화면(FE admin.operations.blockers.<code>)이 이 코드로 번역한다. 추가 시 FE 메시지도 함께. */
export type LifecycleBlockerCode =
  | 'DEADLINE_PASSED'
  | 'REWARDS_UNFUNDED'
  | 'PENDING_APPLICATIONS'
  | 'UNSUBMITTED_PARTICIPANTS'
  | 'UNRESOLVED_SUBMISSIONS'
  | 'UNPAID_WINNERS';

type LifecycleBlocker = { code: LifecycleBlockerCode; count?: number; message: string };

/**
 * 바운티 상태 전이 차단 사유(blockers) 계산.
 * 운영 화면 표시와 실제 전이 검증이 같은 규칙을 쓰도록 이 서비스 하나만 사용한다.
 *
 * COMPLETED의 UNPAID_WINNERS는 두 가지를 센다 (규칙은 rewards/payout-status.ts — 여기서 상태 목록을 새로 쓰지 말 것):
 *   unpaid    진행 중 payout(OPEN_PAYOUT_STATUSES) — 승인/송금이 끝나지 않았다. CANCELLED/FAILED/PAID는 세지 않는다.
 *   unawarded 아직 받을 몫이 남은 승인 제출 (owesUnpaidRewardSql — 응답의 payoutStatus가 PENDING/PARTIALLY_PAID인 것과 같은 규칙).
 *             보상 풀이 다른 수상자에게 다 배정됐거나(여유분 없음), 수상이 취소된(CANCELLED payout만 있는) 제출은 막지 않는다 —
 *             승인은 되돌릴 수 없고 IN_REVIEW에서 CANCELLED로 바로 갈 수도 없어서(재오픈 IN_REVIEW → OPEN → CANCELLED만 있다),
 *             그런 제출로 막으면 바운티가 영영 끝나지 않는다.
 *             FAILED payout이 걸린 제출은 받을 몫이 남은 것이라 막는다 — 운영자가 온체인 미송금을 확인한 뒤 CANCELLED로 닫는다
 *             (docs/runbook.md §7.4 "FAILED payout" 항목. 문서의 취소 SQL WHERE는 FAILED를 받지 않으므로 그 항목대로 바꿔 돌린다).
 *             미요청인데 수령자가 탈퇴한 제출도 막지 않는다 (requestPayout이 404 — payout-status.ts recipientActiveSql).
 *
 * CANCELLED도 같은 UNPAID_WINNERS(같은 코드·문구 — FE 변경 없음)로 막는다. 전이표상 IN_REVIEW → OPEN(재오픈, 마감이 미래일 때 —
 * 운영자가 update로 마감을 늘릴 수 있다) → CANCELLED가 열려 있는데, 취소 뒤 환불(scripts/record-refund.js)은 입금액 − PAID를
 * 돌려주므로 승인됐지만 아직 못 받은 수상자의 몫이 스폰서에게 돌아간다. 받을 몫이 남은 수상자가 있으면 취소할 수 없다 —
 * 모두 지급하거나 runbook §7.4대로 수상을 취소(CANCELLED payout)한 뒤에 취소 → 환불한다 (docs/decisions.md "취소 시 환불").
 */
@Injectable()
export class BountyLifecycleService {
  /** Shared server-side blockers for the operations UI and transitions. */
  async blockers(runner: Pick<DatabaseService, 'query'>, bountyId: string, bounty: { status: string; submission_deadline?: string | Date }) {
    const r = await runner.query(`SELECT
      (SELECT count(*)::int FROM bounty_application WHERE bounty_id = $1 AND status = 'PENDING') AS pending,
      (SELECT count(*)::int FROM bounty_application a WHERE a.bounty_id = $1 AND a.status = 'APPROVED'
        AND NOT EXISTS (SELECT 1 FROM bounty_submission s WHERE s.bounty_id = a.bounty_id
          AND (s.submitter_user_id = a.applicant_user_id OR s.agent_id = a.agent_id))
        -- 탈퇴한 참가자(또는 탈퇴한 소유자의 에이전트)는 영영 제출하지 못한다 - 탈퇴는 APPROVED 지원을 철회하지 않으므로 세지 않으면 마감 전까지 접수를 닫을 수 없다
        AND EXISTS (SELECT 1 FROM "user" ou WHERE ou.deleted_at IS NULL
          AND ou.id = COALESCE(a.applicant_user_id, (SELECT ag.owner_user_id FROM agent ag WHERE ag.id = a.agent_id)))
        -- 폐기(REVOKED)·삭제된 에이전트도 제출할 수 없다 - 에이전트 개별 폐기는 승인된 지원을 철회하지 않는다
        AND (a.agent_id IS NULL OR EXISTS (SELECT 1 FROM agent ag WHERE ag.id = a.agent_id AND ag.deleted_at IS NULL AND ag.status <> 'REVOKED'))) AS unsubmitted,
      (SELECT count(*)::int FROM bounty_submission WHERE bounty_id = $1
        AND status = ANY($2::text[])) AS unresolved,
      (SELECT count(*)::int FROM bounty_reward WHERE bounty_id = $1
        AND status NOT IN (${sqlStatusList(PAYABLE_REWARD_STATUSES)})) AS unfunded,
      (SELECT count(*)::int FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
        WHERE rw.bounty_id = $1 AND p.status IN (${sqlStatusList(OPEN_PAYOUT_STATUSES)})) AS unpaid,
      (SELECT count(*)::int FROM bounty_submission s JOIN bounty b ON b.id = s.bounty_id
        WHERE s.bounty_id = $1 AND s.status = 'APPROVED' AND ${owesUnpaidRewardSql('s', 'b')}) AS unawarded`,
    // $2 미결 제출 상태 — 탈퇴 시 철회 대상과 같은 집합 (bounties/submission-status.ts)
    // 보상/payout 상태 목록은 rewards/payout-status.ts 상수를 리터럴로 렌더링한다 (지급 규칙을 바꾸려면 그 파일을 고친다)
    [bountyId, SubmissionStatusPolicy.unresolvedStatuses()]);
    const c = r.rows[0];
    const expired = !!bounty.submission_deadline && new Date(bounty.submission_deadline).getTime() <= Date.now();
    const details: Record<string, LifecycleBlocker[]> = { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [], CANCELLED: [] };
    const add = (to: string, code: LifecycleBlockerCode, message: string, count?: number) =>
      details[to].push(count === undefined ? { code, message } : { code, count, message });
    if (expired) add('OPEN', 'DEADLINE_PASSED', 'Extend the submission deadline before opening this bounty.');
    if (c.unfunded) add('OPEN', 'REWARDS_UNFUNDED', 'Confirm all reward deposits before opening this bounty.', c.unfunded);
    if (c.pending) {
      add('SUBMISSION_CLOSED', 'PENDING_APPLICATIONS', `Review ${c.pending} pending application(s) before closing submissions.`, c.pending);
      add('COMPLETED', 'PENDING_APPLICATIONS', `Resolve ${c.pending} pending application(s).`, c.pending);
    }
    if (c.unsubmitted && !expired) add('SUBMISSION_CLOSED', 'UNSUBMITTED_PARTICIPANTS', `${c.unsubmitted} approved participant(s) have not submitted. Wait for their work or the submission deadline.`, c.unsubmitted);
    if (c.unresolved) add('COMPLETED', 'UNRESOLVED_SUBMISSIONS', `Finish ${c.unresolved} submission review(s), including requested revisions.`, c.unresolved);
    if (c.unpaid || c.unawarded) {
      const owed = 'Record completed payments for all approved winners and finish every pending payout.';
      add('COMPLETED', 'UNPAID_WINNERS', owed);
      // 취소 뒤 환불은 입금액 − PAID — 남은 수상자 몫이 스폰서에게 돌아가지 않게 같은 규칙으로 막는다
      add('CANCELLED', 'UNPAID_WINNERS', owed);
    }
    // `blockers` (English sentences) is the transition's 400 body and the original operations field — kept verbatim.
    // `blockerDetails` carries the same list as stable codes (+ count) so the admin UI can localize it.
    const blockers = Object.fromEntries(Object.entries(details).map(([to, list]) => [to, list.map((item) => item.message)]));
    const blockerDetails = Object.fromEntries(Object.entries(details).map(([to, list]) =>
      [to, list.map(({ code, count }) => (count === undefined ? { code } : { code, count }))]));
    return { blockers, blockerDetails };
  }
}
