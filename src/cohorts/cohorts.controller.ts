import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AuthedRequest } from '../auth/authed-request';
import { PUBLIC_READ_IP_THROTTLE } from '../common/throttler/public-read-throttle';
import { CohortApplicationFields, UpdateCohortApplicationDto } from './cohort-fields';
import { CohortApplicationsService } from './cohort-applications.service';
import { CohortsService } from './cohorts.service';

/** 지원 쓰기(제출·수정·철회)는 IP당 10/min: 전역 120/min 보다 조인다 */
const APPLICATION_WRITE_THROTTLE = { default: { ttl: 60_000, limit: 10 } };

@Controller('cohorts')
export class CohortsController {
  constructor(
    private readonly cohorts: CohortsService,
    private readonly applications: CohortApplicationsService,
  ) {}

  /** GET /cohorts/current: 열린 기수 또는 JSON `null` (공개). Nest 는 null 반환을 빈 본문으로 보내므로 직접 json 으로 보낸다 */
  @Throttle(PUBLIC_READ_IP_THROTTLE)
  @Get('current')
  async current(@Res() res: Response) {
    res.json(await this.cohorts.current());
  }

  /** GET /cohorts/applications/me: 내 지원 내역 (심사 메모 제외) */
  @UseGuards(AuthGuard)
  @Get('applications/me')
  mine(@Req() req: AuthedRequest) {
    return this.applications.mine(req.user.userId);
  }

  /** POST /cohorts/:id/applications: 지원 (온보딩 완료자만, 접수 중인 기수만) */
  @UseGuards(AuthGuard)
  @Throttle(APPLICATION_WRITE_THROTTLE)
  @Post(':id/applications')
  apply(@Param('id', ParseUUIDPipe) cohortId: string, @Req() req: AuthedRequest, @Body() dto: CohortApplicationFields) {
    return this.applications.apply(cohortId, req.user.userId, dto);
  }

  /** PATCH /cohorts/applications/:id: 본인 지원서 수정 (SUBMITTED + 접수 중) */
  @UseGuards(AuthGuard)
  @Throttle(APPLICATION_WRITE_THROTTLE)
  @Patch('applications/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: UpdateCohortApplicationDto) {
    return this.applications.update(id, req.user.userId, dto);
  }

  /** POST /cohorts/applications/:id/withdraw: 본인 철회 (SUBMITTED -> WITHDRAWN) */
  @UseGuards(AuthGuard)
  @Throttle(APPLICATION_WRITE_THROTTLE)
  @Post('applications/:id/withdraw')
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.applications.withdraw(id, req.user.userId);
  }
}
