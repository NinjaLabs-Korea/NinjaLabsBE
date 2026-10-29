// scripts/forfeit-award.js의 타입 선언 — src/test-db/ops-scripts.db-spec.ts가 실 DB로, src/test-support/forfeit-award.spec.ts가 순수 함수를 검증한다.
import type { Pool } from 'pg';
import type { OpsRun } from './ops-cli';

export type ForfeitSubmissionRow = {
  id: string;
  bounty_id: string;
  submission_status: string;
  current_revision_no: number;
  bounty_status: string;
  bounty_deleted: boolean;
  payouts: number;
  nfts: number;
};
export type ForfeitAdminRow = { id: string; is_admin: boolean; status: string; deleted: boolean };

export declare const run: OpsRun;
export declare const FORFEITABLE_BOUNTY_STATUSES: string[];
export declare const ACTION: string;
export declare const REASON_MAX: number;
export declare function normalizeReason(raw: unknown): string | null;
export declare function reasonProblem(raw: unknown): string | null;
export declare function reviewComment(reason: string): string;
export declare function refusalReason(submission: ForfeitSubmissionRow | null, admin: ForfeitAdminRow | null): string | null;
export declare function forfeitAward(pool: Pool, submissionId: string, adminId: string, reason: string): Promise<{ bountyId: string }>;
export declare function inspectSubmission(
  runner: Pick<Pool, 'query'>,
  submissionId: string,
  adminId: string,
  lock?: boolean,
): Promise<{ submission: ForfeitSubmissionRow | null; admin: ForfeitAdminRow | null }>;
