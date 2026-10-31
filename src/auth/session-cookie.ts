import { Request, Response } from 'express';
import { parseCookies, serializeCookie } from '../common/http/cookies';

/**
 * refresh token의 HttpOnly 쿠키 모드 (docs/api-contract.md "인증", docs/security.md "refresh 쿠키").
 *
 * FE는 `/api/auth/*`를 Next.js rewrite로 이 서버의 `/auth/*`에 프록시한다 - 브라우저가 보는 경로가 `/api/auth`이므로 쿠키 Path도
 * `/api/auth`이고, Domain은 두지 않는다(FE 호스트 전용 first-party 쿠키).
 *
 * 요청별 옵트인: `X-Ninja-Session: cookie` 헤더가 있을 때만 쿠키를 읽고 쓴다. 헤더가 없으면 쿠키는 **무시**되고 기존 본문 모드
 * (`{refreshToken}` 본문 ↔ 응답 본문)다. 이 커스텀 헤더가 CSRF 방어선이다 - 교차 사이트 폼은 헤더를 붙일 수 없고, 교차 출처 JS는
 * CORS preflight에서 막힌다 (SameSite=Strict와 이중).
 */
export const SESSION_MODE_HEADER = 'x-ninja-session';
export const SESSION_MODE_COOKIE = 'cookie';
export const REFRESH_COOKIE = 'ninja_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';

const BASE_ATTRIBUTES = { httpOnly: true, secure: true, sameSite: 'Strict', path: REFRESH_COOKIE_PATH } as const;

export function isCookieMode(req: Pick<Request, 'headers'>): boolean {
  const value = req.headers[SESSION_MODE_HEADER];
  return typeof value === 'string' && value.trim().toLowerCase() === SESSION_MODE_COOKIE;
}

/** 쿠키 모드 요청의 `ninja_rt` (비어 있으면 undefined). 본문 모드에서는 부르지 않는다 */
export function readRefreshCookie(req: Pick<Request, 'headers'>): string | undefined {
  const value = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
  return value ? value : undefined;
}

export function setRefreshCookie(res: Pick<Response, 'append'>, refreshToken: string, maxAgeSeconds: number): void {
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, refreshToken, { ...BASE_ATTRIBUTES, maxAgeSeconds }));
}

export function clearRefreshCookie(res: Pick<Response, 'append'>): void {
  res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, '', { ...BASE_ATTRIBUTES, maxAgeSeconds: 0 }));
}

/**
 * throttler가 버킷 키로 쓸 "제시된 refresh 토큰" - 컨트롤러와 같은 우선순위: 쿠키 모드면 본문 토큰(레거시 이전) 다음 쿠키,
 * 본문 모드면 본문 토큰만. 문자열이 아니면 undefined (ValidationPipe가 뒤에서 400을 낸다).
 */
export function presentedRefreshToken(req: Pick<Request, 'headers' | 'body'>): string | undefined {
  const body = (req.body ?? {}) as { refreshToken?: unknown };
  const fromBody = typeof body.refreshToken === 'string' && body.refreshToken ? body.refreshToken : undefined;
  if (!isCookieMode(req)) return fromBody;
  return fromBody ?? readRefreshCookie(req);
}
