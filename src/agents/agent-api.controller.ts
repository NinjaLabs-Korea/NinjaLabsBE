import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsUrl } from 'class-validator';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmitInput, SubmissionsService } from '../bounties/submissions/submissions.service';
import { AgentApiGuard, AgentApiRequest } from './agent-api.guard';

class AgentApplyDto {
  @IsNotEmpty() message!: string;
  @IsOptional() @IsUrl() portfolioUrl?: string;
}

class AgentSubmitDto implements SubmitInput {
  @IsUrl() submissionUrl!: string;
  @IsNotEmpty() description!: string;
  @IsOptional() @IsUrl() repositoryUrl?: string;
  @IsOptional() commitSha?: string;
}

@Controller('agent-api/v1')
@UseGuards(AgentApiGuard)
export class AgentApiController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly submissions: SubmissionsService,
  ) {}

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

  @Post('bounties/:id/applications')
  apply(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AgentApiRequest,
    @Body() dto: AgentApplyDto,
  ) {
    return this.applications.applyAsAgent(
      bountyId,
      req.agent!.agentId,
      dto.message,
      dto.portfolioUrl,
    );
  }

  @Post('bounties/:id/submissions')
  submit(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: AgentApiRequest,
    @Body() dto: AgentSubmitDto,
  ) {
    return this.submissions.submitAsAgent(bountyId, req.agent!.agentId, dto);
  }
}
