import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsUrl } from 'class-validator';
import { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { SessionUser } from '../../auth/auth.service';
import { ApplicationsService } from './applications.service';

class ApplyDto {
  @IsNotEmpty()
  message!: string;

  @IsOptional()
  @IsUrl()
  portfolioUrl?: string;
}

@Controller()
@UseGuards(AuthGuard)
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /** POST /bounties/:id/applications — 지원형 바운티 지원 */
  @Post('bounties/:id/applications')
  apply(
    @Param('id', ParseUUIDPipe) bountyId: string,
    @Req() req: Request & { user: SessionUser },
    @Body() dto: ApplyDto,
  ) {
    return this.applications.apply(bountyId, req.user.userId, dto.message, dto.portfolioUrl);
  }

  /** GET /applications/me — 내 지원 내역 */
  @Get('applications/me')
  mine(@Req() req: Request & { user: SessionUser }) {
    return this.applications.myApplications(req.user.userId);
  }

  /** POST /applications/:id/withdraw — 지원 철회 */
  @Post('applications/:id/withdraw')
  withdraw(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: SessionUser },
  ) {
    return this.applications.withdraw(id, req.user.userId);
  }
}
