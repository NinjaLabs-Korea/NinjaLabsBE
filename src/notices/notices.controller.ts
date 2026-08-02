import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { NoticesService } from './notices.service';

@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  /** GET /notices?page=&pageSize=&category= — 공지/소식 목록 (공개) */
  @Get()
  list(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '10',
    @Query('category') category?: string,
  ) {
    return this.notices.list(Number(page), Math.min(Number(pageSize), 50), category);
  }

  /** GET /notices/:id — 공지 상세 (공개) */
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.notices.detail(id);
  }
}
