import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NftsService } from './nfts.service';
import { NftJobWorker } from './nft-job.worker';
import { InjectiveNftClient } from './injective-nft.client';
import { NftJobsAdminController } from './nft-jobs-admin.controller';
import { NftJobsAdminService } from './nft-jobs-admin.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [NftJobsAdminController],
  providers: [NftsService, NftJobWorker, InjectiveNftClient, NftJobsAdminService],
  exports: [NftsService],
})
export class NftsModule {}
