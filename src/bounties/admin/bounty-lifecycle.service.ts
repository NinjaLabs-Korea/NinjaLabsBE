import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';

/**
 * 바운티 상태 전이 차단 사유(blockers) 계산.
 * 운영 화면 표시와 실제 전이 검증이 같은 규칙을 쓰도록 이 서비스 하나만 사용한다.
 */
@Injectable()
export class BountyLifecycleService {
  /** Shared server-side blockers for the operations UI and transitions. */
  async blockers(runner: Pick<DatabaseService, 'query'>, bountyId: string, bounty: { status: string; submission_deadline?: string | Date }) {
    const r = await runner.query(`SELECT
      (SELECT count(*)::int FROM bounty_application WHERE bounty_id = $1 AND status = 'PENDING') AS pending,
      (SELECT count(*)::int FROM bounty_application a WHERE a.bounty_id = $1 AND a.status = 'APPROVED'
        AND NOT EXISTS (SELECT 1 FROM bounty_submission s WHERE s.bounty_id = a.bounty_id
          AND (s.submitter_user_id = a.applicant_user_id OR s.agent_id = a.agent_id))) AS unsubmitted,
      (SELECT count(*)::int FROM bounty_submission WHERE bounty_id = $1
        AND status IN ('SUBMITTED','RESUBMITTED','IN_REVIEW','REVISION_REQUESTED')) AS unresolved,
      (SELECT count(*)::int FROM bounty_reward WHERE bounty_id = $1
        AND status NOT IN ('FUNDED','PARTIALLY_PAID','PAID')) AS unfunded,
      (SELECT count(*)::int FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
        WHERE rw.bounty_id = $1 AND p.status <> 'PAID') AS unpaid,
      (SELECT count(*)::int FROM bounty_submission s WHERE s.bounty_id = $1 AND s.status = 'APPROVED'
        AND EXISTS (SELECT 1 FROM bounty_reward rw WHERE rw.bounty_id = $1)
        AND NOT EXISTS (SELECT 1 FROM payout p JOIN bounty_reward rw ON rw.id = p.bounty_reward_id
          WHERE p.submission_id = s.id AND rw.bounty_id = $1 AND p.status = 'PAID')) AS unawarded`, [bountyId]);
    const c = r.rows[0];
    const expired = !!bounty.submission_deadline && new Date(bounty.submission_deadline).getTime() <= Date.now();
    const blockers: Record<string, string[]> = { OPEN: [], SUBMISSION_CLOSED: [], IN_REVIEW: [], COMPLETED: [] };
    if (expired) blockers.OPEN.push('Extend the submission deadline before opening this bounty.');
    if (c.unfunded) blockers.OPEN.push('Confirm all reward deposits before opening this bounty.');
    if (c.pending) {
      blockers.SUBMISSION_CLOSED.push(`Review ${c.pending} pending application(s) before closing submissions.`);
      blockers.COMPLETED.push(`Resolve ${c.pending} pending application(s).`);
    }
    if (c.unsubmitted && !expired) blockers.SUBMISSION_CLOSED.push(`${c.unsubmitted} approved participant(s) have not submitted. Wait for their work or the submission deadline.`);
    if (c.unresolved) blockers.COMPLETED.push(`Finish ${c.unresolved} submission review(s), including requested revisions.`);
    if (c.unpaid || c.unawarded) blockers.COMPLETED.push('Record completed payments for all approved winners and finish every pending payout.');
    return { blockers };
  }
}
