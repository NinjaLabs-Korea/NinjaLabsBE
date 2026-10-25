/**
 * `Authorization: Bearer <token>` 헤더에서 토큰을 꺼낸다 — 없거나 모양이 다르면 undefined.
 * 스킴은 대소문자를 구분하지 않는다(RFC 7235 §2.1: `bearer x`도 유효). 사용자 JWT(auth/auth.guard.ts)와 에이전트 API 키
 * (agents/agent-api.guard.ts)가 같은 파서를 쓴다 — 한쪽만 엄격하면 같은 클라이언트가 어떤 라우트에서만 401이 된다.
 */
export function bearerTokenOf(header: string | undefined): string | undefined {
  return /^Bearer ([^\s]+)$/i.exec(header ?? '')?.[1];
}
