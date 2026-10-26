import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { NullIfBlank, Trim } from '../common/validation/trim';
import { HasVisibleText } from '../common/validation/visible-text';
import { IsHttpUrlOrMediaPath, IsPublicHttpUrl, IsSafeUrl } from '../common/validation/url';
import { NoticeAdminService } from './notice-admin.service';
import { IsCalendarDate } from '../common/validation/calendar-date';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';

const NOTICE_CATEGORIES = ['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER'];

export class CreateNoticeDto {
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @MaxChars(200) title!: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(500) summary?: string;
  @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @MaxLength(50_000) body!: string;
  @IsIn(NOTICE_CATEGORIES) category!: string;
  @IsOptional() @IsHttpUrlOrMediaPath() thumbnailUrl?: string;
  // 공개 공지가 여는 링크라 localhost·사설 IP·내부 호스트는 거부 (IsPublicHttpUrl). 수정은 완화 규칙을 유지한다: 저장된 레거시 값이 PATCH를 막지 않게
  @IsOptional() @IsPublicHttpUrl() externalUrl?: string;
  /** 행사 날짜 (YYYY-MM-DD, 달력에 있는 날짜). 선택, EVENT 아닌 공지에도 저장은 된다 */
  @IsOptional() @IsCalendarDate() eventDate?: string | null;
  @IsOptional() @IsBoolean() publish?: boolean;
}

// 수정: TEXT 컬럼의 상한은 생성의 2배, URL은 완화 규칙(IsSafeUrl) — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로 엄격 규칙 이전의 레거시 행이
// 모든 PATCH를 막지 않게 한다 (common/validation/url.ts, bounty-admin.dto.ts와 같은 이유). title은 VARCHAR(200) — 컬럼 상한을 넘기지 않는다 (MaxChars).
// NOT NULL 컬럼(title/body/category)과 publish는 null을 400으로 막는다 (IsOptionalNotNull) — summary·URL은 nullable이라 null = 지우기.
export class UpdateNoticeDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @MaxChars(200) title?: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(1000) summary?: string;
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @HasVisibleText() @MaxLength(100_000) body?: string;
  @IsOptionalNotNull() @IsIn(NOTICE_CATEGORIES) category?: string;
  @IsOptional() @IsSafeUrl() thumbnailUrl?: string;
  @IsOptional() @IsSafeUrl() externalUrl?: string;
  /** null = 행사 날짜 지우기 */
  @IsOptional() @IsCalendarDate() eventDate?: string | null;
  @IsOptionalNotNull() @IsBoolean() publish?: boolean;
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
