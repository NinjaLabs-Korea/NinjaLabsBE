import { QueryRunner } from '../common/database/database.service';
import { CohortApplicationStatus } from './cohort-status';

/**
 * 회원 탈퇴 시 cohort_application 정리: 호출자(users/account-withdrawal.service.ts)의 트랜잭션 안에서 실행한다.
 * 이 테이블의 소유는 cohorts 모듈이라 SQL 을 여기 둔다 (bounties/participation-withdrawal.ts 와 같은 방식).
 *
 * 심사 전(SUBMITTED) 지원서만 WITHDRAWN 으로 바꾼다. 행은 지우지 않는다: 감사·모집 이력이 남고, 이미 내려진 결정(ACCEPTED/REJECTED)도 기록으로 둔다.
 * 연락처 등 지원서 내용도 이력으로 남는다 (개인정보 처리방침 갱신 필요: wiki/be/cohorts.md 남은 일).
 * 지워지는 건 user 행의 식별자(익명화된 닉네임/이메일 프리픽스)뿐이라 운영자 목록은 탈퇴한 사람의 지원서를 `withdrawn_xxxx` 닉네임으로 보여 준다.
 */
export async function withdrawOpenCohortApplicationsOfUser(tx: QueryRunner, userId: string): Promise<void> {
  await tx.query(
    `UPDATE cohort_application SET status = $2
      WHERE user_id = $1 AND status = $3`,
    [userId, CohortApplicationStatus.WITHDRAWN, CohortApplicationStatus.SUBMITTED],
  );
}
