import { ConfigService } from '@nestjs/config';
import { authRedirectOrigins, isProduction, LOCAL_AUTH_SUCCESS_REDIRECT } from '../common/bootstrap-checks';
import { OriginAllowlist } from '../common/origin-allowlist';

/**
 * 로그인 완료 후 FE로 돌려보내는 기본 URL — AUTH_SUCCESS_REDIRECT. 개발에서 미설정이면 로컬 FE.
 * production에는 폴백이 없다 — AuthModule.onModuleInit의 requireProductionAuthUrls가 미설정/localhost 값으로는 기동을 거부한다
 * (여기서 빈 문자열이면 URL이 아니므로 returnTo도 받지 않는다 — auth.controller.ts).
 */
export function authSuccessRedirectUrl(config: Pick<ConfigService, 'get'>): string {
  const configured = config.get<string>('AUTH_SUCCESS_REDIRECT');
  if (isProduction({ NODE_ENV: config.get<string>('NODE_ENV') })) return configured ?? '';
  return configured ?? LOCAL_AUTH_SUCCESS_REDIRECT;
}

/**
 * 로그인 플로우가 신뢰하는 FE 오리진 — AUTH_SUCCESS_REDIRECT의 오리진(항상) + AUTH_ALLOWED_REDIRECT_ORIGINS.
 * returnTo 검증(auth.controller.ts)과 Turnstile siteverify `hostname` 검증(turnstile.verifier.ts)이 같은 목록을 쓴다.
 * AUTH_SUCCESS_REDIRECT가 URL이 아니면 그 항목만 빠진다. production에서는 AUTH_ALLOWED_REDIRECT_ORIGINS의 루프백 항목도 빠진다 (bootstrap-checks.ts).
 */
export function feRedirectAllowlist(config: Pick<ConfigService, 'get'>): OriginAllowlist {
  let successOrigin: string[] = [];
  try {
    successOrigin = [new URL(authSuccessRedirectUrl(config)).origin];
  } catch {
    successOrigin = [];
  }
  const { kept } = authRedirectOrigins({
    NODE_ENV: config.get<string>('NODE_ENV'),
    AUTH_ALLOWED_REDIRECT_ORIGINS: config.get<string>('AUTH_ALLOWED_REDIRECT_ORIGINS'),
  });
  return new OriginAllowlist([...successOrigin, ...kept]);
}
