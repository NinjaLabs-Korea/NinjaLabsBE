import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BountiesModule } from '../bounties/bounties.module';
import { throttlerModule } from '../common/throttler/throttler-options';
import { AGENT_API_THROTTLER, AgentApiThrottlerGuard } from './agent-api-throttler.guard';
import { AgentApiController } from './agent-api.controller';
import { AgentApiGuard } from './agent-api.guard';
import { AgentApiKeyService } from './agent-api-key.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [
    AuthModule,
    AuditModule,
    BountiesModule,
    // Agent API 키별 한도용 별도 throttler 저장소 — 전역 IP 한도(app.module.ts)와 독립
    // 저장소는 THROTTLER_STORAGE를 따른다 (production 기본 postgres — 레플리카 간 공유, docs/agent-api.md "Rate limit")
    throttlerModule([AGENT_API_THROTTLER]),
  ],
  controllers: [AgentsController, AgentApiController],
  providers: [AgentsService, AgentApiKeyService, AgentApiGuard, AgentApiThrottlerGuard],
})
export class AgentsModule {}
