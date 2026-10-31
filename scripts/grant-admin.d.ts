// scripts/grant-admin.js의 타입 선언 - src/test-db/ops-scripts.db-spec.ts가 실 DB로 검증한다.
import type { Pool } from 'pg';
import type { OpsRun } from './ops-cli';

export type AdminTarget = { id: string; email: string; nickname: string; status: string; is_admin: boolean };

export declare const run: OpsRun;
export declare function findUserByEmail(
  runner: Pick<Pool, 'query'>,
  email: string,
  lock?: boolean,
): Promise<AdminTarget>;
export declare function applyAdminChange(
  pool: Pool,
  options: { email: string; grant: boolean; force?: boolean },
): Promise<{ changed: boolean; user: AdminTarget }>;
export declare function countOtherActiveAdmins(runner: Pick<Pool, 'query'>, userId: string): Promise<number>;
