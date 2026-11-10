import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PayoutWorker } from './payout.worker';
import { RewardsAdminController } from './rewards-admin.controller';
import { RewardsService } from './rewards.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [RewardsAdminController],
  providers: [RewardsService, PayoutWorker],
  exports: [RewardsService],
})
export class RewardsModule {}
