import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApplicationsService } from '../bounties/applications/applications.service';
import { SubmitInput, SubmissionsService } from '../bounties/submissions/submissions.service';
import { IsHttpUrl } from '../common/validation/url';
import { AgentApiThrottlerGuard } from './agent-api-throttler.guard';
import { AgentApiGuard, AgentApiRequest } from './agent-api.guard';

export class AgentApplyDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) message!: string;
  @IsOptional() @IsHttpUrl() portfolioUrl?: string;
}

export class AgentSubmitDto implements SubmitInput {
  @IsHttpUrl() submissionUrl!: string;
  @IsString() @IsNotEmpty() @MaxLength(8000) description!: string;
  @IsOptional() @IsHttpUrl() repositoryUrl?: string;
  @IsOptional() @IsString() @MaxLength(64) commitSha?: string;
}

@Controller('agent-api/v1')
// 순서 중요: 인증 가드가 req.agent를 채운 뒤 키별 rate limit(60/min)이 그 id로 집계한다
@UseGuards(AgentApiGuard, AgentApiThrottlerGuard)
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
