import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { createMockDb, SqlHandler } from './mock-db';

export type Counts = Partial<Record<'pending' | 'unsubmitted' | 'unresolved' | 'unfunded' | 'unpaid' | 'unawarded', number>>;

export const FUTURE = '2999-01-01T00:00:00.000Z';
export const PAST = '2000-01-01T00:00:00.000Z';
export const ZERO: Counts = { pending: 0, unsubmitted: 0, unresolved: 0, unfunded: 0, unpaid: 0, unawarded: 0 };

/** 차단 사유 카운트 SELECT(여섯 개 서브카운트 한 문장)의 핸들러. 카운트 -> 사유 매핑만 검증하는 단위 스펙용: 카운트가 실제 행에서 어떻게 나오는지는 test-db/bounty-lifecycle.db-spec.ts */
export const countsHandler = (counts: Counts): SqlHandler => ({
  match: /AS unawarded$/,
  reply: () => ({ rowCount: 1, rows: [{ ...ZERO, ...counts }] }),
});

/**
 * BountyAdminService.transition 이 내는 문장들의 엄격 모드 핸들러: 바운티 잠금, 카운트, 상태 UPDATE, 취소 연쇄(지원서 반려, 제출 반려와 심사 행), 감사.
 * `status`가 null이면 바운티가 없다. 등록하지 않은 문장은 `Unexpected SQL`로 실패한다.
 */
export function transitionHandlers(status: string | null, counts: Counts = {}, deadline = FUTURE, closedSubmissionIds: string[] = []): SqlHandler[] {
  const ok = { rowCount: 1, rows: [] };
  return [
    { match: /FROM bounty WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE$/, reply: () => (status === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ status, submission_deadline: deadline }] }) },
    countsHandler(counts),
    { match: /^UPDATE bounty SET status = \$2/, reply: () => ok },
    { match: /^UPDATE bounty_application/, reply: () => ok },
    { match: /^UPDATE bounty_submission SET status/, reply: () => ({ rowCount: closedSubmissionIds.length, rows: closedSubmissionIds.map((id) => ({ id })) }) },
    { match: /^INSERT INTO submission_review/, reply: () => ok },
    { match: /^INSERT INTO audit_log/, reply: () => ok },
  ];
}

export function transitionSetup(status: string | null, counts: Counts = {}, deadline = FUTURE, closedSubmissionIds: string[] = []) {
  const mock = createMockDb({ strict: true, handlers: transitionHandlers(status, counts, deadline, closedSubmissionIds) });
  const service = new BountyAdminService(mock.database, new AuditService(mock.database), new BountyLifecycleService(), {} as RewardTokenResolver);
  return { service, mock };
}
