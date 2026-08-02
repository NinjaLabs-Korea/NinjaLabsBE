import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { BountiesService } from './bounties.service';

@Controller('bounties')
export class BountiesController {
  constructor(private readonly bounties: BountiesService) {}

  /** GET /bounties?page=&pageSize=&category=&status= — 바운티 목록 (공개) */
  @Get()
  list(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '12',
    @Query('category') category?: string,
    @Query('status') status?: string,
  ) {
    return this.bounties.list(Number(page), Math.min(Number(pageSize), 50), category, status);
  }

  /** GET /bounties/:id — 바운티 상세 (공개) */
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.bounties.detail(id);
  }
}
