import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { BountiesService } from './bounties.service';

class ListBountiesQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() status?: string;
}

@Controller('bounties')
export class BountiesController {
  constructor(private readonly bounties: BountiesService) {}

  /** GET /bounties?page=&pageSize=&category=&status= — 바운티 목록 (공개) */
  @Get()
  list(@Query() query: ListBountiesQueryDto) {
    return this.bounties.list(query.page ?? 1, query.pageSize ?? 12, query.category, query.status);
  }

  /** GET /bounties/:id — 바운티 상세 (공개) */
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.bounties.detail(id);
  }
}
