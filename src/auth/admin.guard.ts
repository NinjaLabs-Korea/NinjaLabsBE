import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from './auth.guard';
import { SessionUser } from './auth.service';

/** AuthGuard 통과 후 is_admin까지 요구하는 가드 (/admin/* 전용) */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.authGuard.canActivate(context);
    const req = context.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    if (!req.user?.isAdmin) throw new ForbiddenException('ADMIN_ONLY');
    return true;
  }
}
