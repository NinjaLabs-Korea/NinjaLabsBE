import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BountiesModule } from '../bounties/bounties.module';
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
    // TODO(scale): 이 저장소도 인스턴스별 in-memory — 레플리카 2대 이상 전에 공유 저장소(Redis/pg)로 (docs/agent-api.md "Rate limit")
    ThrottlerModule.forRoot([AGENT_API_THROTTLER]),
  ],
  controllers: [AgentsController, AgentApiController],
  providers: [AgentsService, AgentApiKeyService, AgentApiGuard, AgentApiThrottlerGuard],
})
export class AgentsModule {}
