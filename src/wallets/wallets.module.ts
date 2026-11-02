import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NftsModule } from '../nfts/nfts.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { AuditModule } from '../audit/audit.module';
import { WalletReplacementController } from './wallet-replacement.controller';
import { WalletReplacementService } from './wallet-replacement.service';

@Module({
  imports: [AuthModule, NftsModule, AuditModule],
  controllers: [WalletsController, WalletReplacementController],
  providers: [WalletsService, WalletReplacementService],
  exports: [WalletsService],
})
export class WalletsModule {}
