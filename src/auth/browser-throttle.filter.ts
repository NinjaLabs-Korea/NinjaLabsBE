import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerException } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { OriginAllowlist } from '../common/origin-allowlist';
import { feRedirectAllowlist, resolveFeRedirect } from './fe-origins';

/** FE `ERROR_COPY.loginCallback.codes`에 전용 문구("잠시 후 다시")가 있는 코드 */
export const TOO_MANY_REQUESTS_CODE = 'TOO_MANY_REQUESTS';

/**
 * 브라우저가 최상위 이동으로 여는 라우트(`GET /auth/google`, `GET /auth/google/callback`)의 한도 초과를 JSON 429 대신
 * FE `/auth/callback#error=TOO_MANY_REQUESTS` 302로 바꾼다. 한도 가드는 핸들러보다 먼저 돌아 컨트롤러의 `redirectStartFailure`에 닿지 못하므로
 * 라우트에 붙인 예외 필터로 잡는다. 학교·행사 Wi-Fi처럼 NAT 뒤 사용자가 같은 IP를 공유하면 20/min을 쉽게 넘는다.
 * 시작 라우트의 `returnTo`는 컨트롤러와 같은 허용 목록 규칙으로 검증하고, 콜백에는 `returnTo`가 없어 기본 FE로 간다. `Retry-After`는 유지한다.
 */
@Catch(ThrottlerException)
export class BrowserNavigationThrottleFilter implements ExceptionFilter {
  private allowlist?: OriginAllowlist;

  constructor(private readonly config: ConfigService) {}

  catch(_exception: ThrottlerException, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const returnTo = typeof req.query?.returnTo === 'string' ? req.query.returnTo : undefined;
    const fe = resolveFeRedirect(this.config, (this.allowlist ??= feRedirectAllowlist(this.config)), returnTo);
    // FE 주소를 만들 수 없는 설정이면(production은 기동이 거부한다) 기존처럼 JSON 429
    if (!URL.canParse(fe)) {
      res.status(429).json({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
      return;
    }
    const url = new URL('/auth/callback', fe);
    url.hash = new URLSearchParams({ error: TOO_MANY_REQUESTS_CODE }).toString();
    res.setHeader('Retry-After', '60');
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(url.toString());
  }
}
