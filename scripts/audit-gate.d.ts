// scripts/audit-gate.js의 타입 선언 — src/**/audit-gate.spec.ts가 사용한다.
export interface AuditAdvisory {
  id: string;
  pkg: string;
  severity: string;
  title?: string;
  url?: string;
}
export interface AllowlistEntry {
  id: string;
  reason: string;
  expires: string;
}
export declare function collectAdvisories(report: unknown): AuditAdvisory[];
export declare function evaluate(
  report: unknown,
  allowlist: unknown[],
  today?: string,
): { ok: boolean; errors: string[]; allowed: AuditAdvisory[]; blocked: AuditAdvisory[] };
export interface SpawnResultLike {
  error?: { code?: string };
  signal?: string | null;
  status?: number | null;
  stdout?: string;
  stderr?: string;
}
export type AttemptOutcome = { kind: 'ok'; report: unknown } | { kind: 'network' | 'fatal'; reason: string };
export declare function classifyAttempt(res: SpawnResultLike): AttemptOutcome;
export declare function auditWithRetry(
  run: () => SpawnResultLike,
  sleep: (ms: number) => void,
  maxAttempts?: number,
): AttemptOutcome;
