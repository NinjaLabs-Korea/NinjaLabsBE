import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AccountWithdrawalService } from './account-withdrawal.service';
import { throttlerModule } from '../common/throttler/throttler-options';
import { UsersController } from './users.controller';
import { UserAvatarService } from './user-avatar.service';
import { UserThrottlerGuard, USER_AVATAR_THROTTLER } from './user-throttler.guard';
import { UsersService } from './users.service';

@Module({
  // 프로필 사진 업로드·삭제의 유저별 한도 - 전역 IP 한도와 독립된 저장소 (user-throttler.guard.ts)
  imports: [AuthModule, AuditModule, throttlerModule([USER_AVATAR_THROTTLER])],
  controllers: [UsersController],
  providers: [UsersService, AccountWithdrawalService, UserAvatarService, UserThrottlerGuard],
  exports: [UsersService],
})
export class UsersModule {}
