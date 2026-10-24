import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { MAX_PAGE } from '../common/pagination.dto';
import { AdminGuard } from '../auth/admin.guard';
import { AuditService } from './audit.service';

export class AuditLogsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_PAGE) page?: number;
  @IsOptional() @IsString() @MaxLength(64) entityType?: string;
  @IsOptional() @IsUUID() entityId?: string;
}

@Controller('admin/audit-logs')
@UseGuards(AdminGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** GET /admin/audit-logs?entityType=&entityId=&page= — 감사 로그 조회 → `{ items, page, pageSize, total }` (30건/페이지) */
  @Get()
  list(@Query() query: AuditLogsQueryDto) {
    return this.audit.list({ page: query.page ?? 1, entityType: query.entityType, entityId: query.entityId });
  }
}
