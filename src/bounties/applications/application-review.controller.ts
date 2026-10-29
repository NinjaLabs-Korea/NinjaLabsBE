import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn } from 'class-validator';
import { AdminGuard } from '../../auth/admin.guard';
import { AuthedRequest } from '../../auth/authed-request';
import { NullableDisplayBody } from '../../common/validation/display-text';
import { ApplicationReviewDecision, ApplicationStatusPolicy } from '../application-status';
import { ApplicationReviewService } from './application-review.service';

export class ReviewApplicationDto {
  @IsIn(ApplicationStatusPolicy.reviewDecisions()) decision!: ApplicationReviewDecision;
  @NullableDisplayBody(2000) note?: string;
}

@Controller('admin/applications')
@UseGuards(AdminGuard)
export class ApplicationReviewController {
  constructor(private readonly reviews: ApplicationReviewService) {}

  @Post(':id/review')
  review(
    @Param('id', ParseUUIDPipe) applicationId: string,
    @Req() req: AuthedRequest,
    @Body() dto: ReviewApplicationDto,
  ) {
    return this.reviews.review(applicationId, dto.decision, dto.note, req.user.userId);
  }
}
