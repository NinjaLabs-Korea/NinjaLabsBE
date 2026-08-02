import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BountiesController } from './bounties.controller';
import { BountiesService } from './bounties.service';
import { ApplicationsController } from './applications/applications.controller';
import { ApplicationsService } from './applications/applications.service';
import { SubmissionsController } from './submissions/submissions.controller';
import { SubmissionsService } from './submissions/submissions.service';

@Module({
  imports: [AuthModule],
  controllers: [BountiesController, ApplicationsController, SubmissionsController],
  providers: [BountiesService, ApplicationsService, SubmissionsService],
  exports: [BountiesService],
})
export class BountiesModule {}
