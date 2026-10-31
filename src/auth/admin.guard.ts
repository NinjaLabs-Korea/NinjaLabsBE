import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { DatabaseService } from '../common/database/database.service';
import { AuthGuard } from './auth.guard';
import { SessionUser } from './auth.service';
import { activeUserSql } from '../users/active-user';

/**
 * AuthGuard 통과 후 is_admin까지 요구하는 가드 (/admin/* 전용).
 * JWT의 adm 클레임은 발급 시점 스냅샷이라, 어드민 해제·계정 정지·탈퇴가 access token 만료(15분) 전에도
 * 즉시 반영되도록 "user" 행을 다시 확인한다 (어드민 요청당 쿼리 1회). **부여도 같다** — adm 클레임이 false인 토큰을 먼저 거르지 않는다:
 * grant-admin.js 직후 /auth/me(DB 기준 isAdmin)는 true인데 /admin/*만 최대 15분 403이던 불일치를 없앤다 (adm 클레임은 더 이상 권한 판단에 쓰지 않는다). AuthGuard도 ACTIVE/미삭제를 확인하지만 30초 캐시라(auth.service.ts
 * USER_STATUS_CACHE_TTL_MS) 운영자 권한만큼은 캐시 없이 매번 본다 — 두 가드의 조건(users/active-user.ts `activeUserSql`)은 같다.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly authGuard: AuthGuard,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.authGuard.canActivate(context);
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    if (!req.user) throw new ForbiddenException('ADMIN_ONLY');
    const r = await this.db.query(
      `SELECT 1 FROM "user"
        WHERE id = $1 AND is_admin = true AND ${activeUserSql('')}`,
      [req.user.userId],
    );
    if (!r.rowCount) throw new ForbiddenException('ADMIN_ONLY');
    return true;
  }
}
