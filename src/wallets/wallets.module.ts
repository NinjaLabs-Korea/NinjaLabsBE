import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NftsModule } from '../nfts/nfts.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [AuthModule, NftsModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
