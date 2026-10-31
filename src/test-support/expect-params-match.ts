/**
 * 유닛 스펙용 - SQL 문자열의 가장 큰 `$n`과 바인딩 배열 길이가 같은지 단언한다.
 * SQL과 params 배열이 따로 수정돼 어긋나는 드리프트(한쪽만 파라미터를 추가/삭제)를 mock DB에서도 잡는다.
 * 실제 타입 추론 충돌(같은 `$n`을 bare/캐스트로 섞어 쓰는 42P08)은 test-db(실 Postgres)가 잡는다.
 */
export function highestPlaceholder(sql: string): number {
  let max = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(match[1]));
  return max;
}

export function expectParamsMatch(sql: string, params: unknown[] | undefined): void {
  const expected = highestPlaceholder(sql);
  const actual = params?.length ?? 0;
  if (actual !== expected) {
    throw new Error(
      `SQL binds ${actual} parameter(s) but references $1..$${expected}:\n${sql.trim()}\nparams: ${JSON.stringify(params)}`,
    );
  }
}

/** jest.fn 쿼리 mock을 감싸 모든 호출에서 expectParamsMatch를 실행한다 (호출 기록은 원래 mock에 그대로 남는다) */
export function withParamsCheck<T extends (sql: string, params?: unknown[]) => unknown>(query: T): T {
  return ((sql: string, params?: unknown[]) => {
    expectParamsMatch(sql, params);
    return query(sql, params);
  }) as T;
}
