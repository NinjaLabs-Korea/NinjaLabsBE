import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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

/** POST /bounties/:id/submissions 본문 */
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

/**
 * PUT /submissions/:id/payout-address 본문. 형식 검증(0x/inj1, 체크섬, 20바이트, 0 주소)은 서비스가 하고 400 INVALID_INJECTIVE_ADDRESS로 답한다
 * (DTO 메시지가 아니라 코드로 - FE가 코드로 문구를 고른다). 여기서는 문자열·길이만 본다.
 */
export class SetPayoutAddressDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  address!: string;
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

  /** PUT /submissions/:id/payout-address - 승인된 내 제출의 지급 주소 입력/수정 (payout 요청 전까지만) */
  @Put('submissions/:id/payout-address')
  setPayoutAddress(
    @Param('id', ParseUUIDPipe) submissionId: string,
    @Req() req: Request & { user: SessionUser },
    @Body() dto: SetPayoutAddressDto,
  ) {
    return this.submissions.setPayoutAddress(submissionId, req.user.userId, dto.address);
  }

  /** GET /submissions/me - 내 제출 내역 */
  @Get('submissions/me')
  mine(@Req() req: Request & { user: SessionUser }) {
    return this.submissions.mySubmissions(req.user.userId);
  }
}
