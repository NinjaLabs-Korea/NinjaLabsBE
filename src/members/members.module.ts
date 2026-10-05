import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { MemberAdminController } from './member-admin.controller';
import { MemberAdminService } from './member-admin.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [MembersController, MemberAdminController],
  providers: [MembersService, MemberAdminService],
})
export class MembersModule {}
