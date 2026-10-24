// scripts/record-refund.js의 타입 선언 — src/test-db/ops-scripts.db-spec.ts가 실 DB로 검증한다.
import type { Pool } from 'pg';
import type { OpsRun } from './ops-cli';

export declare const run: OpsRun;
export declare function normalizeTxHash(raw: unknown): string | null;
export declare function recordRefund(pool: Pool, rewardId: string, hash: string): Promise<{ refundedAmount: string }>;
export declare function inspectReward(
  runner: Pick<Pool, 'query'>,
  rewardId: string,
  lock?: boolean,
): Promise<{ reward: Record<string, any> | null; refundedAmount: string | null }>;
