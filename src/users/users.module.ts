import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { AccountWithdrawalService } from './account-withdrawal.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [UsersController],
  providers: [UsersService, AccountWithdrawalService],
  exports: [UsersService],
})
export class UsersModule {}
