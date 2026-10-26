import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateIf } from 'class-validator';
import { MAX_PAGE } from '../common/pagination.dto';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { MemberAdminService } from './member-admin.service';
import { MaxPgInt } from '../common/validation/optional-not-null';
import { MaxChars } from '../common/validation/max-chars';
import { Trim } from '../common/validation/trim';

export class SetMemberDto {
  @IsBoolean()
  isMember!: boolean;

  // 멤버로 지정할 때는 역할이 필수다 - 없으면 member_role NULL로 저장돼 공개 멤버 페이지가 Core로 잘못 분류한다.
  // 해제(isMember false)에는 역할을 보내지 않아도 된다 (보내도 무시하고 NULL로 지운다)
  @ValidateIf((dto: SetMemberDto) => dto.isMember === true || dto.role !== undefined)
  @IsIn(['CORE', 'DEV', 'DESIGN', 'OPS'])
  role?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @MaxPgInt() // user.member_display_order INTEGER
  displayOrder?: number;
}

export class SearchUsersQueryDto {
  // 이메일(320)·닉네임(50)보다 긴 검색어는 어떤 행과도 맞지 않는다 — 쿼리스트링으로 들어오는 수 KB짜리 ILIKE 패턴을 DB에 넘기지 않는다
  // 앞뒤 공백은 지운다 — 복사해 붙인 "ninja@x.com "이 어떤 이메일과도 안 맞아 빈 목록이 되던 것 (공백만 있으면 빈 검색어 = 최신 가입순)
  @IsOptional() @Trim() @IsString() @MaxChars(320)
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
