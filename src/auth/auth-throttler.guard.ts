import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { Request } from 'express';
import { presentedRefreshToken } from './session-cookie';

/**
 * `/auth/exchange`·`/auth/refresh`·`/auth/logout` 전용 한도 — **제시된 자격 증명의 해시** 기준 10/min (auth.module.ts의 throttlerModule()에 같은 이름).
 *
 * FE가 `/api/auth/*`를 Vercel(Next.js rewrite)로 프록시하면 이 서버가 보는 클라이언트 IP는 Vercel의 공유 egress IP다 — IP 기준
 * 10/min이면 서로 다른 사용자들이 한 버킷을 나눠 쓰다 정당한 refresh가 429가 된다. 그래서 refresh·logout은 refresh 토큰(쿠키 또는 본문)의
 * sha256, exchange는 로그인 코드의 sha256으로 버킷을 나눈다. 자격 증명이 없으면 IP로 떨어진다 — 단 토큰 없는 logout은 아무것도 폐기하지 않는
 * 204(쿠키 모드)거나 400(본문 모드)이라 이 한도를 건너뛴다(shouldSkip): IP로 떨어뜨리면 egress IP 하나를 나눠 쓰는 사용자들의 로그아웃이 10/min에 막힌다.
 * IP 기준의 거친 한도는 전역 throttler(app.module.ts)가 이 라우트에도 건다 — 단 IP당 600/min으로 올려서(AUTH_PROXIED_ROUTE_IP_THROTTLE) — 토큰을 바꿔 가며 두드리는 것은
 * 그쪽이 막는다(refresh 토큰 384비트·로그인 코드 256비트+PKCE라 추측 자체가 비현실적).
 * 원문 토큰은 키에 남기지 않는다(해시만 — 저장소 덤프/로그에서 쓸 수 없게).
 */
export const AUTH_TOKEN_THROTTLER = { name: 'auth-token', ttl: 60_000, limit: 10 } as const;

/**
 * `/auth/exchange`·`/auth/refresh`·`/auth/logout`에만 거는 전역(IP) throttler 덮어쓰기 — 120/min → **600/min**.
 * 운영 트래픽은 FE의 Vercel rewrite(`/api/auth/*`)를 거쳐 오므로 이 서버가 보는 IP는 소수의 Vercel egress IP다. 전역 IP당 120/min을
 * 그대로 두면 많은 사용자가 그 버킷을 나눠 써 정상 refresh·logout이 429가 된다. 사용자별 제한은 위의 토큰 해시별 10/min이 맡고,
 * 이 600/min은 egress IP 하나에서 오는 무차별 대입에 대한 거친 상한으로만 남는다. 프록시되는 이 세 auth 라우트 밖은 전역 120/min 그대로
 * (공개 GET은 따로 600/min — common/throttler/public-read-throttle.ts, docs/security.md).
 */
export const AUTH_PROXIED_ROUTE_IP_THROTTLE = { default: { ttl: 60_000, limit: 600 } } as const;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class AuthTokenThrottlerGuard extends ThrottlerGuard {
  /** 토큰 없는 logout은 폐기할 세션이 없다 — 해시 한도를 건너뛴다 (IP 버킷 10/min을 egress IP 사용자들이 나눠 쓰지 않게). 전역 IP 600/min은 그대로 걸린다 */
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getHandler().name !== 'logout') return false;
    return !presentedRefreshToken(context.switchToHttp().getRequest<Request>());
  }

  protected async getTracker(req: Record<string, unknown>, context?: ExecutionContext): Promise<string> {
    const request = req as unknown as Request;
    const handler = context?.getHandler().name;
    if (handler === 'exchange') {
      const code = (request.body as { code?: unknown } | undefined)?.code;
      if (typeof code === 'string' && code) return `code:${sha256(code)}`;
    } else {
      const token = presentedRefreshToken(request);
      if (token) return `refresh:${sha256(token)}`;
    }
    return `ip:${request.ip}`;
  }
}
