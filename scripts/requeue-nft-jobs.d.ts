// scripts/requeue-nft-jobs.js의 타입 선언 — src/test-db/ops-scripts.db-spec.ts가 실 DB로 검증한다.
import type { Pool } from 'pg';
import type { OpsRun } from './ops-cli';

export type FailedJob = {
  id: string;
  nft_id: string;
  job_type: string;
  retry_count: number;
  last_error: string | null;
  processed_at: Date | null;
  nft_status: string;
};

export declare const run: OpsRun;
export declare function findFailedJobs(runner: Pick<Pool, 'query'>, ids: string[] | null, lock?: boolean): Promise<FailedJob[]>;
export declare function requeueJobs(pool: Pool, ids: string[] | null): Promise<string[]>;
