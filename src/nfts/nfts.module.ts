import { Module } from '@nestjs/common';
import { NftsService } from './nfts.service';
import { NftJobWorker } from './nft-job.worker';

@Module({
  providers: [NftsService, NftJobWorker],
  exports: [NftsService],
})
export class NftsModule {}
