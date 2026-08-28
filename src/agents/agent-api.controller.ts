import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AgentApiGuard, AgentApiRequest } from './agent-api.guard';

@Controller('agent-api/v1')
@UseGuards(AgentApiGuard)
export class AgentApiController {
  @Get('me')
  me(@Req() req: AgentApiRequest) {
    const agent = req.agent!;
    return {
      agentId: agent.agentId,
      ownerUserId: agent.ownerUserId,
      name: agent.name,
      walletAddress: agent.walletAddress,
      status: 'ACTIVE',
    };
  }
}
