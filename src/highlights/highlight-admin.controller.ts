import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { HighlightAdminService } from './highlight-admin.service';

const HIGHLIGHT_TYPES = ['MILESTONE', 'FEATURED_BOUNTY', 'PROJECT', 'PARTNERSHIP', 'AWARD', 'OTHER'];

class CreateHighlightDto {
  @IsIn(HIGHLIGHT_TYPES) type!: string;
  @IsNotEmpty() title!: string;
  @IsNotEmpty() description!: string;
  @IsOptional() imageUrl?: string;
  @IsOptional() linkUrl?: string;
  @IsOptional() @IsUUID() bountyId?: string;
  @IsOptional() @Type(() => Number) @IsInt() displayOrder?: number;
  @IsOptional() @IsBoolean() publish?: boolean;
}

class UpdateHighlightDto {
  @IsOptional() @IsIn(HIGHLIGHT_TYPES) type?: string;
  @IsOptional() title?: string;
  @IsOptional() description?: string;
  @IsOptional() imageUrl?: string;
  @IsOptional() linkUrl?: string;
  @IsOptional() @Type(() => Number) @IsInt() displayOrder?: number;
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
