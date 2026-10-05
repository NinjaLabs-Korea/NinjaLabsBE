import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { RewardsService } from './rewards.service';
import { PayoutWorker } from './payout.worker';
import { NftsModule } from '../nfts/nfts.module';

@Module({
  imports: [AuthModule, AuditModule, NftsModule],
  providers: [RewardsService, PayoutWorker],
  exports: [RewardsService],
})
export class RewardsModule {}
