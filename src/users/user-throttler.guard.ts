import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { throttleIpKey } from '../common/throttler/ip-throttler.guard';

/**
 * `POST·DELETE /users/me/avatar` 전용 한도 - **로그인 유저 id 기준** 10/min (users.module.ts의 throttlerModule()에 같은 이름).
 *
 * FE가 `/api/*`를 Vercel로 프록시하면 이 서버가 보는 IP는 공유 egress IP라, IP 기준 10/min이면 서로 다른 회원이 한 버킷을 나눠 쓴다.
 * 인증된 라우트이므로 AuthGuard가 채운 `req.user.userId`의 sha256으로 버킷을 나눈다 (같은 유저는 IP가 바뀌어도 같은 버킷, 다른 유저는 별개).
 * 반드시 `@UseGuards(AuthGuard, UserThrottlerGuard)` 순서로 쓴다. 유저가 없으면(오용) IP 키로 떨어진다.
 * IP 기준의 거친 한도는 전역 throttler(app.module.ts, IP당 120/min)가 이 라우트에도 그대로 건다.
 */
export const USER_AVATAR_THROTTLER = { name: 'user-avatar', ttl: 60_000, limit: 10 } as const;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req.user as { userId?: unknown } | undefined)?.userId;
    return typeof userId === 'string' && userId ? `user:${sha256(userId)}` : `ip:${throttleIpKey(req.ip as string | undefined)}`;
  }
}
