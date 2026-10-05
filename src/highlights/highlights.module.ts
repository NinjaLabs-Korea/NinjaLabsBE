import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { HighlightAdminController } from './highlight-admin.controller';
import { HighlightAdminService } from './highlight-admin.service';
import { HighlightsController } from './highlights.controller';
import { HighlightsService } from './highlights.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [HighlightsController, HighlightAdminController],
  providers: [HighlightsService, HighlightAdminService],
  exports: [HighlightsService],
})
export class HighlightsModule {}
