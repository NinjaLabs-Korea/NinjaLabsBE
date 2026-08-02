import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RewardsModule } from '../rewards/rewards.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AuthModule, RewardsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
