import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { NoticeAdminController } from './notice-admin.controller';
import { NoticeAdminService } from './notice-admin.service';
import { NoticesController } from './notices.controller';
import { NoticesService } from './notices.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [NoticesController, NoticeAdminController],
  providers: [NoticesService, NoticeAdminService],
  exports: [NoticesService],
})
export class NoticesModule {}
