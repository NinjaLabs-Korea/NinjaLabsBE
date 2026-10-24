// scripts/ops-cli.js의 타입 선언 — 운영 스크립트 공용 (src/test-db/ops-scripts.db-spec.ts, src/test-support/ops-cli.spec.ts).
import type { Pool } from 'pg';

export declare function loadDotEnv(): void;
export declare function createPool(env?: Record<string, string | undefined>): Pool;
export declare function parseArgs(
  argv: string[],
  known: string[],
): { flags: Record<string, true>; positional: string[] };
export declare function extractValueOptions(
  argv: string[],
  names: string[],
): { values: Record<string, string>; rest: string[] };
export declare function promptYes(question: string): Promise<boolean>;
export declare function runCli(run: OpsRun): Promise<void>;
export declare class OpsError extends Error {
  code: string;
  constructor(code: string, message: string);
}
export declare const UUID_RE: RegExp;

export type OpsDeps = { pool: Pool; prompt?: (question: string) => Promise<boolean>; log?: (line: string) => void };
/** 종료 코드: 0 성공/변경 없음/dry-run, 1 거부·중단·대상 없음, 2 사용법 오류 */
export type OpsRun = (argv: string[], deps: OpsDeps) => Promise<number>;
