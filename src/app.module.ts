import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard } from '@nestjs/throttler';
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
import { AuditModule } from './audit/audit.module';
import { MediaModule } from './media/media.module';
import { MaintenanceModule } from './common/maintenance/maintenance.module';
import { throttlerModule } from './common/throttler/throttler-options';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(), // nft_job / payout 워커 폴링용
    // 전역 rate limit: IP당 분당 120회 (가입 어뷰징·무차별 대입 1차 방어)
    // 민감 엔드포인트(auth, check-nickname)는 컨트롤러에서 @Throttle로 더 조일 것
    // 저장소: THROTTLER_STORAGE=postgres(production 기본)면 레플리카 간 공유 pg 테이블, memory면 인스턴스별 (common/throttler/throttler-options.ts)
    throttlerModule([{ ttl: 60_000, limit: 120 }]),
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
    AuditModule,
    MediaModule,
    MaintenanceModule, // 만료 challenge/세션/로그인 코드 정리 (매시)
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
