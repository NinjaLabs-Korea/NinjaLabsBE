import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Min } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { MemberAdminService } from './member-admin.service';

export class SetMemberDto {
  @IsBoolean()
  isMember!: boolean;

  @IsOptional()
  @IsIn(['CORE', 'DEV', 'DESIGN', 'OPS'])
  role?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  displayOrder?: number;
}

@Controller('admin/users')
@UseGuards(AdminGuard)
export class MemberAdminController {
  constructor(private readonly members: MemberAdminService) {}

  @Get()
  searchUsers(@Query('q') q = '') {
    return this.members.searchUsers(q);
  }

  @Post(':id/member')
  setMember(
    @Param('id', ParseUUIDPipe) userId: string,
    @Req() req: AuthedRequest,
    @Body() dto: SetMemberDto,
  ) {
    return this.members.setMember(userId, dto.isMember, dto.role, dto.displayOrder, req.user.userId);
  }
}
