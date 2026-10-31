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
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { SessionUser } from '../../auth/auth.service';
import { Trim } from '../../common/validation/trim';
import { HasVisibleText } from '../../common/validation/visible-text';
import { IsPublicHttpUrl } from '../../common/validation/url';
import { SubmissionsService } from './submissions.service';

/** 사람(POST /bounties/:id/submissions)과 에이전트(agent-api)가 같은 규칙을 쓴다 - AgentSubmitDto가 이 클래스를 상속한다 */
export class SubmitDto {
  @IsPublicHttpUrl()
  submissionUrl!: string;

  @Trim()
  @IsString()
  @IsNotEmpty()
  @HasVisibleText() // 제로폭 문자만으로 된 설명은 검토자에게 빈 화면이다
  @MaxLength(8000)
  description!: string;

  @IsOptional()
  @IsPublicHttpUrl()
  repositoryUrl?: string;

  // git 커밋 해시: 16진수 4~64자 (SHA-1 40자·SHA-256 64자, 축약형 허용). FE가 비운 칸을 ''로 보내므로 빈 문자열은 허용 (저장은 그대로 '')
  @IsOptional()
  @Trim()
  @IsString()
  @Matches(/^(?:[0-9a-fA-F]{4,64})?$/, { message: 'commitSha must be a hex git commit hash (4 to 64 hex characters)' })
  commitSha?: string;
}

@Controller()
@UseGuards(AuthGuard)
export class SubmissionsController {
  constructor(private readonly submissions: SubmissionsService) {}

  /** POST /bounties/:id/submissions - 제출/재제출 (재제출 시 리비전 증가) */
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

  /** GET /submissions/me - 내 제출 내역 */
  @Get('submissions/me')
  mine(@Req() req: Request & { user: SessionUser }) {
    return this.submissions.mySubmissions(req.user.userId);
  }
}
