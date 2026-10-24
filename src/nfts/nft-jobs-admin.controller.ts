import { Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { MAX_PAGE } from '../common/pagination.dto';
import { NFT_JOB_ADMIN_STATUSES, NftJobAdminStatus, NftJobsAdminService } from './nft-jobs-admin.service';

export class NftJobsQueryDto {
  @IsOptional() @IsIn(NFT_JOB_ADMIN_STATUSES) status?: NftJobAdminStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE) page?: number;
}

@Controller('admin/nft-jobs')
@UseGuards(AdminGuard)
export class NftJobsAdminController {
  constructor(private readonly jobs: NftJobsAdminService) {}

  /** GET /admin/nft-jobs?status=FAILED|PENDING|PROCESSING&page= → `{ items, page, pageSize, total }` (30건/페이지, 기본 FAILED) */
  @Get()
  list(@Query() query: NftJobsQueryDto) {
    return this.jobs.list({ status: query.status ?? 'FAILED', page: query.page ?? 1 });
  }

  /** POST /admin/nft-jobs/:id/retry — FAILED → PENDING (retry_count 0), 감사 NFT_JOB_RETRIED. 아니면 404 NFT_JOB_NOT_FOUND_OR_NOT_FAILED */
  @Post(':id/retry')
  retry(@Param('id', ParseUUIDPipe) jobId: string, @Req() req: AuthedRequest) {
    return this.jobs.retry(jobId, req.user.userId);
  }
}
