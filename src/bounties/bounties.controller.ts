import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
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

  /** GET /bounties?page=&pageSize=&category=&status= - 바운티 목록 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get()
  list(@Query() query: ListBountiesQueryDto) {
    return this.bounties.list(query.page ?? 1, query.pageSize ?? 12, query.category, query.status);
  }

  /** GET /bounties/:id - 바운티 상세 (공개) */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.bounties.detail(id);
  }
}
