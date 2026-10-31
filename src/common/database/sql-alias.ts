const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL 조각 함수가 받는 테이블 별칭 검사 - 별칭은 문장에 그대로 들어가므로 식별자 모양만 받는다(사용자 입력이 아니라 호출부 상수).
 * 별칭이 없으면(빈 문자열) 접두사 없이 컬럼 이름만 쓴다.
 */
export function sqlColumnPrefix(alias: string, fn: string): string {
  if (alias === '') return '';
  if (!IDENTIFIER.test(alias)) throw new Error(`${fn}: alias must be an identifier`);
  return `${alias}.`;
}

/** SQL 조각 함수가 받는 바인딩 자리(`$1`, `$2`...) 검사 */
export function sqlParam(param: string, fn: string): string {
  if (!/^\$[1-9][0-9]*$/.test(param)) throw new Error(`${fn}: expected a bind placeholder like $1`);
  return param;
}
