import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AdminGuard } from '../../auth/admin.guard';
import { AuthedRequest } from '../../auth/authed-request';
import { SubmissionStatusPolicy } from '../submission-status';
import { SubmissionReviewService } from './submission-review.service';
import { IsOptionalNotNull, MaxPgInt } from '../../common/validation/optional-not-null';

export class ReviewSubmissionDto {
  // 생략 = 낙관적 검사 없음. null은 400 — IsOptional이면 null이 통과해 서비스의 `!== undefined` 비교에서 SUBMISSION_REVISION_CHANGED("다른 운영자가 고쳤다")로 오해를 샀다
  @IsOptionalNotNull() @Type(() => Number) @IsInt() @Min(1) @MaxPgInt() revisionNo?: number;
  @IsIn(SubmissionStatusPolicy.decisions()) decision!: string;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

@Controller('admin/submissions')
@UseGuards(AdminGuard)
export class SubmissionReviewController {
  constructor(private readonly reviews: SubmissionReviewService) {}

  @Post(':id/review')
  review(
    @Param('id', ParseUUIDPipe) submissionId: string,
    @Req() req: AuthedRequest,
    @Body() dto: ReviewSubmissionDto,
  ) {
    return this.reviews.review(submissionId, dto.decision, dto.comment, req.user.userId, dto.revisionNo);
  }
}
