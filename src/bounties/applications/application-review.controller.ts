import { Body, Controller, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { AdminGuard } from '../../auth/admin.guard';
import { AuthedRequest } from '../../auth/authed-request';
import { ApplicationReviewService } from './application-review.service';

class ReviewApplicationDto {
  @IsIn(['APPROVED', 'REJECTED']) decision!: 'APPROVED' | 'REJECTED';
  @IsOptional() note?: string;
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
