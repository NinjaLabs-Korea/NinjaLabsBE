import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { SessionUser } from '../auth/auth.service';
import { Trim } from '../common/validation/trim';
import { AgentsService } from './agents.service';
import { MaxChars } from '../common/validation/max-chars';

export class RegisterAgentDto {
  /** FE AgentRegisterForm의 maxLength=100과 일치 (docs/agent-api.md "Field limits") */
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxChars(100) // VARCHAR(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  publicKey?: string;

  @IsNotEmpty()
  walletAddress!: string;
}

class VerifyAgentDto {
  @IsNotEmpty()
  signature!: string;
}

@Controller('agents')
@UseGuards(AuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  /** POST /agents — 에이전트 등록 (PENDING_VERIFICATION 상태로 생성) */
  @Post()
  register(@Req() req: Request & { user: SessionUser }, @Body() dto: RegisterAgentDto) {
    return this.agents.register(
      req.user.userId,
      dto.name,
      dto.description,
      dto.publicKey,
      dto.walletAddress,
    );
  }

  /** POST /agents/:id/verify — 주인 지갑 서명 검증 + API key 발급 (원문 1회 노출) */
  @Post(':id/verify')
  verify(
    @Param('id', ParseUUIDPipe) agentId: string,
    @Req() req: Request & { user: SessionUser },
    @Body() dto: VerifyAgentDto,
  ) {
    return this.agents.verifyAndIssueKey(req.user.userId, agentId, dto.signature);
  }

  /** GET /agents/me — 내 에이전트 목록 (키는 prefix만 노출) */
  @Get('me')
  mine(@Req() req: Request & { user: SessionUser }) {
    return this.agents.myAgents(req.user.userId);
  }

  /** POST /agents/:id/keys/rotate — 기존 ACTIVE 키 전부 폐기 + 새 키 발급 (원문 1회 노출) */
  @Post(':id/keys/rotate')
  rotateKey(
    @Param('id', ParseUUIDPipe) agentId: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.agents.rotateKey(req.user.userId, agentId);
  }

  /** POST /agents/:id/revoke — 에이전트와 모든 키 폐기 (멱등) */
  @Post(':id/revoke')
  revoke(
    @Param('id', ParseUUIDPipe) agentId: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.agents.revoke(req.user.userId, agentId);
  }
}
