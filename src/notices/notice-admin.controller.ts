import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { Trim } from '../common/validation/trim';
import { IsHttpUrl, IsHttpUrlOrMediaPath } from '../common/validation/url';
import { NoticeAdminService } from './notice-admin.service';

const NOTICE_CATEGORIES = ['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER'];

export class CreateNoticeDto {
  @Trim() @IsString() @IsNotEmpty() @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsString() @IsNotEmpty() @MaxLength(50_000) body!: string;
  @IsIn(NOTICE_CATEGORIES) category!: string;
  @IsOptional() @IsHttpUrlOrMediaPath() thumbnailUrl?: string;
  @IsOptional() @IsHttpUrl() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

export class UpdateNoticeDto {
  @IsOptional() @Trim() @IsString() @IsNotEmpty() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(500) summary?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50_000) body?: string;
  @IsOptional() @IsIn(NOTICE_CATEGORIES) category?: string;
  @IsOptional() @IsHttpUrlOrMediaPath() thumbnailUrl?: string;
  @IsOptional() @IsHttpUrl() externalUrl?: string;
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
