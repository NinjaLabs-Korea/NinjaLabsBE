import { QueryRunner } from '../common/database/database.service';
import { SubmissionStatusPolicy } from './submission-status';
import { ownedAgentIdsSql } from '../agents/owned-agents';

/**
 * 회원 탈퇴 시 bounty_submission / bounty_application 정리 - 호출자(users/account-withdrawal.service.ts)의 트랜잭션 안에서 실행한다.
 * 이 두 테이블의 소유는 bounties 모듈이라 SQL을 여기 둔다. 서비스가 아닌 함수인 이유: Nest DI 없이도 호출할 수 있고,
 * import 그래프가 가벼워 users 경로가 다른 의존성을 끌어오지 않는다.
 *
 * 본인 또는 내 에이전트의
 *   - 미결 제출(SubmissionStatusPolicy.unresolvedStatuses - bounty-lifecycle이 COMPLETED를 막는 집합과 같다) → WITHDRAWN
 *   - PENDING 지원 → WITHDRAWN
 * 아직 심사가 끝나지 않은 제출도 철회한다 - 남겨 두면 운영자가 승인해 max_winners 자리를 지급 불가능한 제출이 차지하거나
 * (수령 지갑이 없어 requestPayout 404), 미결 제출로 남아 바운티 완료(COMPLETED)를 막는다. 승인/반려된 제출은 기록으로 남는다.
 *
 * "내 에이전트"는 owner_user_id로 찾으므로 에이전트를 REVOKED로 바꾼 뒤에 불러도 같은 행을 본다.
 */
export async function withdrawOpenParticipationOfUser(tx: QueryRunner, userId: string): Promise<void> {
  await tx.query(
    `UPDATE bounty_submission SET status = 'WITHDRAWN'
      WHERE status = ANY($2::text[])
        AND (submitter_user_id = $1
             OR agent_id = ANY(${ownedAgentIdsSql('$1', 'including-deleted')}))`,
    [userId, SubmissionStatusPolicy.unresolvedStatuses()],
  );
  await tx.query(
    `UPDATE bounty_application SET status = 'WITHDRAWN'
      WHERE status = 'PENDING'
        AND (applicant_user_id = $1
             OR agent_id = ANY(${ownedAgentIdsSql('$1', 'including-deleted')}))`,
    [userId],
  );
}
