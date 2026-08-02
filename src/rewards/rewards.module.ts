import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RewardsService } from './rewards.service';
import { PayoutWorker } from './payout.worker';

@Module({
  imports: [AuthModule],
  providers: [RewardsService, PayoutWorker],
  exports: [RewardsService],
})
export class RewardsModule {}
