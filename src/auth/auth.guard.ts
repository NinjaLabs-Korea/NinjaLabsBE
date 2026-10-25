import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { bearerTokenOf } from '../common/http/bearer-token';
import { AuthService, SessionUser } from './auth.service';

/**
 * Authorization: Bearer <accessToken> 검증 가드 — 서명/용도(typ) 검증 뒤 유저가 아직 ACTIVE이고 삭제되지 않았는지 확인한다
 * (AuthService.assertActiveUser, 프로세스별 30초 캐시 → 정지/삭제 반영 지연 ≤ 30초). AdminGuard는 여기에 더해 캐시 없이 is_admin까지 다시 확인한다.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const token = bearerTokenOf(req.headers.authorization);
    if (!token) throw new UnauthorizedException('MISSING_BEARER_TOKEN');
    const user = await this.auth.verifyAccessToken(token);
    await this.auth.assertActiveUser(user.userId);
    req.user = user;
    return true;
  }
}
