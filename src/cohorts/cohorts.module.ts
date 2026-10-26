import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { CohortAdminController } from './cohort-admin.controller';
import { CohortAdminService } from './cohort-admin.service';
import { CohortApplicationAdminService } from './cohort-application-admin.service';
import { CohortApplicationsService } from './cohort-applications.service';
import { CohortsController } from './cohorts.controller';
import { CohortsService } from './cohorts.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [CohortsController, CohortAdminController],
  providers: [CohortsService, CohortApplicationsService, CohortAdminService, CohortApplicationAdminService],
})
export class CohortsModule {}
