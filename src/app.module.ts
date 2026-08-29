import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './common/database/database.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { MembersModule } from './members/members.module';
import { NoticesModule } from './notices/notices.module';
import { HighlightsModule } from './highlights/highlights.module';
import { BountiesModule } from './bounties/bounties.module';
import { RewardsModule } from './rewards/rewards.module';
import { NftsModule } from './nfts/nfts.module';
import { AgentsModule } from './agents/agents.module';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // nft_job / payout 워커 폴링용
    // 전역 rate limit: IP당 분당 120회 (가입 어뷰징·무차별 대입 1차 방어)
    // 민감 엔드포인트(auth, check-nickname)는 컨트롤러에서 @Throttle로 더 조일 것
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    WalletsModule,
    MembersModule,
    NoticesModule,
    HighlightsModule,
    BountiesModule,
    RewardsModule,
    NftsModule,
    AgentsModule,
    AdminModule,
    AuditModule,
    MediaModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
