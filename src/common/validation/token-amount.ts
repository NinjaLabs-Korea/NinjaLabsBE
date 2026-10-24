/** 최소 단위 토큰 금액: 선행 0 없는 양의 정수 문자열 (DECIMAL(78,0)에 맞춤) — DTO와 서비스가 같은 규칙을 쓴다 */
export const TOKEN_AMOUNT = /^[1-9][0-9]{0,77}$/;
