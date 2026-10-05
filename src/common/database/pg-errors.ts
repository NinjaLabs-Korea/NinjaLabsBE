/** PostgreSQL unique_violation (23505) — 유니크 인덱스 충돌 여부 */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
