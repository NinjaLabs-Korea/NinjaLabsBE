import { ConfigService } from '@nestjs/config';
import { OriginAllowlist } from '../common/origin-allowlist';

/** 로그인 완료 후 FE로 돌려보내는 기본 URL — AUTH_SUCCESS_REDIRECT (미설정이면 로컬 FE) */
export function authSuccessRedirectUrl(config: Pick<ConfigService, 'get'>): string {
  return config.get<string>('AUTH_SUCCESS_REDIRECT') ?? 'http://localhost:3000/';
}

/**
 * 로그인 플로우가 신뢰하는 FE 오리진 — AUTH_SUCCESS_REDIRECT의 오리진(항상) + AUTH_ALLOWED_REDIRECT_ORIGINS.
 * returnTo 검증(auth.controller.ts)과 Turnstile siteverify `hostname` 검증(turnstile.verifier.ts)이 같은 목록을 쓴다.
 * AUTH_SUCCESS_REDIRECT가 URL이 아니면 그 항목만 빠진다.
 */
export function feRedirectAllowlist(config: Pick<ConfigService, 'get'>): OriginAllowlist {
  let successOrigin: string[] = [];
  try {
    successOrigin = [new URL(authSuccessRedirectUrl(config)).origin];
  } catch {
    successOrigin = [];
  }
  return new OriginAllowlist([...successOrigin, ...(config.get<string>('AUTH_ALLOWED_REDIRECT_ORIGINS') ?? '').split(',')]);
}
