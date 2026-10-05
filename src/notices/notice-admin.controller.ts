import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { NoticeAdminService } from './notice-admin.service';

const NOTICE_CATEGORIES = ['NINJALABS', 'INJECTIVE_ECOSYSTEM', 'EVENT', 'RECRUITMENT', 'OTHER'];

class CreateNoticeDto {
  @IsNotEmpty() title!: string;
  @IsOptional() summary?: string;
  @IsNotEmpty() body!: string;
  @IsIn(NOTICE_CATEGORIES) category!: string;
  @IsOptional() thumbnailUrl?: string;
  @IsOptional() externalUrl?: string;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class UpdateNoticeDto {
  @IsOptional() title?: string;
  @IsOptional() summary?: string;
  @IsOptional() body?: string;
  @IsOptional() @IsIn(NOTICE_CATEGORIES) category?: string;
  @IsOptional() thumbnailUrl?: string;
  @IsOptional() externalUrl?: string;
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
