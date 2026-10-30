import { DatabaseService } from '../../common/database/database.service';
import { SubmissionDecision } from '../submission-status';

/**
 * 제출물의 **현재 리비전**에 심사 기록(submission_review)을 남기는 단일 출처. 운영자 심사(SubmissionReviewService)와
 * 바운티 취소 연쇄(BountyLifecycleService.closeOpenWork)가 같은 INSERT를 쓴다. 호출자가 제출 행을 이미 잠그고 상태를 바꾼 트랜잭션 안에서 부른다.
 * 현재 리비전 스냅샷이 없는 옛 행은 revision_id NULL로 저장한다(실패하지 않는다).
 */
export async function recordReviews(
  tx: Pick<DatabaseService, 'query'>,
  submissionIds: string[],
  reviewerId: string,
  decision: SubmissionDecision,
  comment: string | null,
): Promise<void> {
  if (!submissionIds.length) return;
  await tx.query(
    `INSERT INTO submission_review (submission_id, revision_id, reviewer_id, decision, comment)
     SELECT s.id,
            (SELECT sr.id FROM submission_revision sr WHERE sr.submission_id = s.id AND sr.revision_no = s.current_revision_no),
            $2::uuid, $3::text, $4::text
       FROM bounty_submission s
      WHERE s.id = ANY($1::uuid[])`,
    [submissionIds, reviewerId, decision, comment],
  );
}
