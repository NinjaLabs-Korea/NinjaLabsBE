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
