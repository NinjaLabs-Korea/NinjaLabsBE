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
import { AuthGuard } from '../../auth/auth.guard';
import { SessionUser } from '../../auth/auth.service';
import { Trim } from '../../common/validation/trim';
import { IsHttpUrl } from '../../common/validation/url';
import { SubmissionsService } from './submissions.service';
import { MaxChars } from '../../common/validation/max-chars';

/** 사람(POST /bounties/:id/submissions)과 에이전트(agent-api)가 같은 규칙을 쓴다 — AgentSubmitDto가 이 클래스를 상속한다 */
export class SubmitDto {
  @IsHttpUrl()
  submissionUrl!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  description!: string;

  @IsOptional()
  @IsHttpUrl()
  repositoryUrl?: string;

  @IsOptional()
  @IsString()
  @MaxChars(64)
  commitSha?: string;
}

@Controller()
@UseGuards(AuthGuard)
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  /** POST /bounties/:id/submissions — 제출/재제출 (재제출 시 리비전 증가) */
  @Post('bounties/:id/submissions')
  submit(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: Request & { user: SessionUser },
    @Body() dto: SubmitDto,
  ) {
    return this.submissions.submit(bountyId, req.user.userId, {
      submissionUrl: dto.submissionUrl,
      description: dto.description,
      repositoryUrl: dto.repositoryUrl,
      commitSha: dto.commitSha,
    });
  }

  /** GET /submissions/me — 내 제출 내역 */
  @Get('submissions/me')
  mine(@Req() req: Request & { user: SessionUser }) {
    return this.submissions.mySubmissions(req.user.userId);
  }
}
