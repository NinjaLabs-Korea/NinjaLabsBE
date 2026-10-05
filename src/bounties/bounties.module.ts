import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { BountyAdminController } from './admin/bounty-admin.controller';
import { BountyAdminService } from './admin/bounty-admin.service';
import { BountyLifecycleService } from './admin/bounty-lifecycle.service';
import { RewardTokenResolver } from './admin/reward-token.resolver';
import { ApplicationReviewController } from './applications/application-review.controller';
import { ApplicationReviewService } from './applications/application-review.service';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { BountiesController } from './bounties.controller';
import { BountiesService } from './bounties.service';
import { SubmissionReviewController } from './submissions/submission-review.controller';
import { SubmissionReviewService } from './submissions/submission-review.service';
import { SubmissionsController } from './submissions/submissions.controller';
import { SubmissionsService } from './submissions/submissions.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [
    // 공개·참여자용
    BountiesController,
    ApplicationsController,
    SubmissionsController,
    // 운영자용 (/admin/*)
    BountyAdminController,
    ApplicationReviewController,
    SubmissionReviewController,
  ],
  providers: [
    BountiesService,
    ApplicationsService,
    SubmissionsService,
    BountyAdminService,
    BountyLifecycleService,
    RewardTokenResolver,
    ApplicationReviewService,
    SubmissionReviewService,
  ],
  exports: [BountiesService, ApplicationsService, SubmissionsService],
})
export class BountiesModule {}
