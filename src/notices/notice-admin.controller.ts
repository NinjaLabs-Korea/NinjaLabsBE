import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { Trim } from '../common/validation/trim';
import { IsHttpUrl, IsHttpUrlOrMediaPath, IsSafeUrl } from '../common/validation/url';
import { NoticeAdminService } from './notice-admin.service';
import { MaxChars } from '../common/validation/max-chars';

const NOTICE_CATEGORIES = ['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER'];

export class CreateNoticeDto {
  @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title!: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsString() @IsNotEmpty() @MaxLength(50_000) body!: string;
  @IsIn(NOTICE_CATEGORIES) category!: string;
  @IsOptional() @IsHttpUrlOrMediaPath() thumbnailUrl?: string;
  @IsOptional() @IsHttpUrl() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

// 수정: TEXT 컬럼의 상한은 생성의 2배, URL은 완화 규칙(IsSafeUrl) — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로 엄격 규칙 이전의 레거시 행이
// 모든 PATCH를 막지 않게 한다 (common/validation/url.ts, bounty-admin.dto.ts와 같은 이유). title은 VARCHAR(200) — 컬럼 상한을 넘기지 않는다 (MaxChars).
export class UpdateNoticeDto {
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title?: string;
  @IsOptional() @IsString() @MaxLength(1000) summary?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100_000) body?: string;
  @IsOptional() @IsIn(NOTICE_CATEGORIES) category?: string;
  @IsOptional() @IsSafeUrl() thumbnailUrl?: string;
  @IsOptional() @IsSafeUrl() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

@Controller('admin/notices')
@UseGuards(AdminGuard)
export class NoticeAdminController {
  constructor(private readonly notices: NoticeAdminService) {}

  @Get()
  list() {
    return this.notices.list();
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateNoticeDto) {
    return this.notices.create(req.user.userId, dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) noticeId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateNoticeDto,
  ) {
    return this.notices.update(noticeId, dto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) noticeId: string, @Req() req: AuthedRequest) {
    return this.notices.remove(noticeId, req.user.userId);
  }
}
