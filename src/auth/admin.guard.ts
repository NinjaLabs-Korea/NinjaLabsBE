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

/**
 * AuthGuard 통과 후 is_admin까지 요구하는 가드 (/admin/* 전용).
 * JWT의 adm 클레임은 발급 시점 스냅샷이라, 어드민 해제·계정 정지·탈퇴가 access token 만료(15분) 전에도
 * 즉시 반영되도록 "user" 행을 다시 확인한다 (어드민 요청당 쿼리 1회).
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
    if (!req.user?.isAdmin) throw new ForbiddenException('ADMIN_ONLY');
    const r = await this.db.query(
      `SELECT 1 FROM "user"
        WHERE id = $1 AND is_admin = true AND status = 'ACTIVE' AND deleted_at IS NULL`,
      [req.user.userId],
    );
    if (!r.rowCount) throw new ForbiddenException('ADMIN_ONLY');
    return true;
  }
}
