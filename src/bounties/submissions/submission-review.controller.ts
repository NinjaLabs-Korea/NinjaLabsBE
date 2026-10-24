import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AdminGuard } from '../../auth/admin.guard';
import { AuthedRequest } from '../../auth/authed-request';
import { SubmissionReviewService } from './submission-review.service';
import { MaxPgInt } from '../../common/validation/optional-not-null';

export class ReviewSubmissionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @MaxPgInt() revisionNo?: number;
  @IsIn(['START_REVIEW', 'REQUEST_REVISION', 'APPROVE', 'REJECT']) decision!: string;
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
