import { Module } from '@nestjs/common';
import { NftsService } from './nfts.service';
import { NftJobWorker } from './nft-job.worker';
import { InjectiveNftClient } from './injective-nft.client';

@Module({
  providers: [NftsService, NftJobWorker, InjectiveNftClient],
  exports: [NftsService],
})
export class NftsModule {}
