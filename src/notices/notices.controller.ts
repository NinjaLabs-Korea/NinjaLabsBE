import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { NoticesService } from './notices.service';

class ListNoticesQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() category?: string;
}

@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  /** GET /notices?page=&pageSize=&category= — 공지/소식 목록 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get()
  list(@Query() query: ListNoticesQueryDto) {
    return this.notices.list(query.page ?? 1, query.pageSize ?? 10, query.category);
  }

  /** GET /notices/:id — 공지 상세 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.notices.detail(id);
  }
}
