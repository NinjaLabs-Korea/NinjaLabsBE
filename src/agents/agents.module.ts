import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BountiesModule } from '../bounties/bounties.module';
import { AgentApiController } from './agent-api.controller';
import { AgentApiGuard } from './agent-api.guard';
import { AgentApiKeyService } from './agent-api-key.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [AuthModule, BountiesModule],
  controllers: [AgentsController, AgentApiController],
  providers: [AgentsService, AgentApiKeyService, AgentApiGuard],
})
export class AgentsModule {}
