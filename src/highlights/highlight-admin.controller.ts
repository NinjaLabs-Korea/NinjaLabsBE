import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { Trim } from '../common/validation/trim';
import { IsHttpUrlOrMediaPath, IsHttpUrlOrSitePath, IsSafeUrl } from '../common/validation/url';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { HighlightAdminService } from './highlight-admin.service';
import { MaxChars } from '../common/validation/max-chars';

const HIGHLIGHT_TYPES = ['MILESTONE', 'FEATURED_BOUNTY', 'PROJECT', 'PARTNERSHIP', 'AWARD', 'OTHER'];

export class CreateHighlightDto {
  @IsIn(HIGHLIGHT_TYPES) type!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title!: string;
  @Trim() @IsString() @IsNotEmpty() @MaxLength(2000) description!: string;
  @IsOptional() @IsHttpUrlOrMediaPath() imageUrl?: string;
  // FE 내부 라우트(`/bounties/<slug>`)도 링크로 쓴다
  @IsOptional() @IsHttpUrlOrSitePath() linkUrl?: string;
  @IsOptional() @IsUUID() bountyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) displayOrder?: number;
  @IsOptional() @IsBoolean() publish?: boolean;
}

// 수정: TEXT 컬럼의 상한은 생성의 2배, URL은 완화 규칙(IsSafeUrl) — FE가 바뀌지 않은 필드도 저장값 그대로 되보내므로 엄격 규칙 이전의 레거시 행이
// 모든 PATCH를 막지 않게 한다 (common/validation/url.ts, bounty-admin.dto.ts와 같은 이유). title은 VARCHAR(200) — 컬럼 상한을 넘기지 않는다 (MaxChars).
export class UpdateHighlightDto {
  @IsOptional() @IsIn(HIGHLIGHT_TYPES) type?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxChars(200) title?: string;
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(4000) description?: string;
  @IsOptional() @IsSafeUrl() imageUrl?: string;
  @IsOptional() @IsSafeUrl() linkUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) displayOrder?: number;
  @IsOptional() @IsBoolean() publish?: boolean;
}

@Controller('admin/highlights')
@UseGuards(AdminGuard)
export class HighlightAdminController {
  constructor(private readonly highlights: HighlightAdminService) {}

  @Get()
  list() {
    return this.highlights.list();
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateHighlightDto) {
    return this.highlights.create(req.user.userId, dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) highlightId: string,
    @Req() req: AuthedRequest,
    @Body() dto: UpdateHighlightDto,
  ) {
    return this.highlights.update(highlightId, dto, req.user.userId);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) highlightId: string, @Req() req: AuthedRequest) {
    return this.highlights.remove(highlightId, req.user.userId);
  }
}
