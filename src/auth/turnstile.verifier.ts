import { BadRequestException, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isProduction } from '../common/bootstrap-checks';
import { logSafe } from '../common/logging/log-safe';
import { OriginAllowlist } from '../common/origin-allowlist';
import { feRedirectAllowlist } from './fe-origins';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** siteverify 응답을 기다리는 최대 시간 - 넘기면 503 TURNSTILE_UNAVAILABLE (로그인 버튼이 무한정 매달리지 않게) */
export const TURNSTILE_TIMEOUT_MS = 5_000;
/** Cloudflare 문서상 토큰 최대 길이 - 넘으면 siteverify를 부르지 않고 400 */
export const TURNSTILE_TOKEN_MAX = 2048;

/**
 * Cloudflare siteverify의 error-codes 중 **우리 쪽(시크릿/Cloudflare) 문제**인 것 - 토큰 탓이 아니므로 400이 아니라 503으로 답하고 error 로그.
 * (invalid-input-response / timeout-or-duplicate / missing-input-response 등 나머지는 토큰 문제 → 400). 시크릿 설정 오류를 400으로 두면 모든 로그인이 "토큰이 잘못됐다"로 보이고 error 로그/알림도 없다
 */
const SERVER_SIDE_ERROR_CODES = new Set([
  'missing-input-secret',
  'invalid-input-secret',
  'invalid-widget-id', // 시크릿에서 읽은 위젯 ID가 없거나 잘못됨 (다른 위젯의 시크릿, 삭제된 위젯)
  'invalid-parsed-secret', // 시크릿이 테스트 키인데 응답은 실제 토큰이거나 그 반대
  'internal-error',
]);

/** FE 위젯이 렌더할 때 넣는 action (NinjaLabsFE `TurnstileWidget` - `action: "login"`). 다른 action의 토큰은 이 로그인에 쓸 수 없다 */
export const TURNSTILE_EXPECTED_ACTION = 'login';

type SiteverifyResponse = { success?: unknown; 'error-codes'?: unknown; hostname?: unknown; action?: unknown };

/**
 * Cloudflare Turnstile 서버측 검증 - 로그인 시작(GET /auth/google)의 봇 방지.
 *
 *   - `TURNSTILE_SECRET_KEY` 미설정: 검사 생략(로컬/개발/e2e). production이면 기동 시 warn 1회 - 봇 방지 없이 열려 있다는 뜻이다.
 *   - 설정됨: 토큰이 없거나 길이 초과 → 400 TURNSTILE_FAILED (siteverify 호출 없음).
 *     siteverify `success:true` + `hostname`이 로그인 FE 오리진(AUTH_SUCCESS_REDIRECT의 오리진 + AUTH_ALLOWED_REDIRECT_ORIGINS - fe-origins.ts,
 *     returnTo 검증과 같은 목록)의 호스트 + `action === 'login'` → 통과.
 *     `success:false`(만료/재사용/위조 토큰), 또는 성공이어도 hostname/action 불일치(같은 사이트 키를 쓰는 다른 사이트·다른 위젯에서 받은 토큰을
 *     재사용) → 400 TURNSTILE_FAILED.
 *     네트워크 오류·5초 초과·비2xx·JSON 아님·시크릿 오류/internal-error → 503 TURNSTILE_UNAVAILABLE.
 * 토큰은 로그에 남기지 않는다 (error-codes만).
 */
@Injectable()
export class TurnstileVerifier implements OnModuleInit {
  private readonly logger = new Logger(TurnstileVerifier.name);

  private readonly allowedHosts: OriginAllowlist;

  constructor(private readonly config: ConfigService) {
    this.allowedHosts = feRedirectAllowlist(config);
  }

  onModuleInit() {
    if (!this.secret() && isProduction({ NODE_ENV: this.config.get<string>('NODE_ENV') })) {
      this.logger.warn(
        'TURNSTILE_SECRET_KEY is not set - GET /auth/google accepts sign-ins without a Cloudflare Turnstile check. ' +
          'Set it (and NEXT_PUBLIC_TURNSTILE_SITE_KEY on the FE) to enable bot protection.',
      );
    }
  }

  get enabled(): boolean {
    return Boolean(this.secret());
  }

  /** 미설정이면 아무것도 하지 않는다. 설정돼 있으면 통과하거나 400/503을 던진다 */
  async verify(token: string | undefined, remoteIp: string | undefined): Promise<void> {
    const secret = this.secret();
    if (!secret) return;
    if (typeof token !== 'string' || token.length === 0 || token.length > TURNSTILE_TOKEN_MAX) {
      throw new BadRequestException('TURNSTILE_FAILED');
    }

    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    let result: SiteverifyResponse;
    try {
      const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
      result = (await res.json()) as SiteverifyResponse;
    } catch (err) {
      this.logger.warn(`Turnstile siteverify unavailable: ${logSafe(err instanceof Error ? `${err.name}: ${err.message}` : err, 200)}`);
      throw new ServiceUnavailableException('TURNSTILE_UNAVAILABLE');
    }

    if (result?.success === true) {
      const hostname = typeof result.hostname === 'string' ? result.hostname : '';
      const action = typeof result.action === 'string' ? result.action : '';
      if (this.allowedHosts.allowsHostname(hostname) && action === TURNSTILE_EXPECTED_ACTION) return;
      // 호스트 이름·action은 사이트 식별값이라 비밀이 아니다 - 원인 구분용으로 남긴다 (CR/LF 이스케이프 + 상한)
      this.logger.log(`Turnstile token rejected: hostname/action mismatch (hostname=${logSafe(hostname || '-', 100)}, action=${logSafe(action || '-', 50)})`);
      throw new BadRequestException('TURNSTILE_FAILED');
    }
    const codes = Array.isArray(result?.['error-codes']) ? result['error-codes'].map(String) : [];
    if (codes.some((code) => SERVER_SIDE_ERROR_CODES.has(code))) {
      this.logger.error(`Turnstile siteverify rejected the server request: ${logSafe(codes.join(','), 200)}`);
      throw new ServiceUnavailableException('TURNSTILE_UNAVAILABLE');
    }
    this.logger.log(`Turnstile token rejected: ${logSafe(codes.join(',') || 'no-error-codes', 200)}`);
    throw new BadRequestException('TURNSTILE_FAILED');
  }

  private secret(): string | undefined {
    return this.config.get<string>('TURNSTILE_SECRET_KEY')?.trim() || undefined;
  }
}
