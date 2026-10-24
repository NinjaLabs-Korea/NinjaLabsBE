import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../common/pagination.dto';
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

export class SearchUsersQueryDto {
  @IsOptional() @IsString()
  q?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE)
  page?: number;
}

@Controller('admin/users')
@UseGuards(AdminGuard)
export class MemberAdminController {
  constructor(private readonly members: MemberAdminService) {}

  /** GET /admin/users?q=&page= — 30건/페이지, 응답은 배열 (FE 계약 유지) */
  @Get()
  searchUsers(@Query() query: SearchUsersQueryDto) {
    return this.members.searchUsers(query.q ?? '', query.page ?? 1);
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
