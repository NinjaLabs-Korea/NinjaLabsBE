import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RewardsService } from './rewards.service';
import { PayoutWorker } from './payout.worker';
import { NftsModule } from '../nfts/nfts.module';

@Module({
  imports: [AuthModule, NftsModule],
  providers: [RewardsService, PayoutWorker],
  exports: [RewardsService],
})
export class RewardsModule {}
