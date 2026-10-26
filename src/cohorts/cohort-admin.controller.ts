import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import { PaginationQueryDto } from '../common/pagination.dto';
import { MaxChars } from '../common/validation/max-chars';
import { IsOptionalNotNull } from '../common/validation/optional-not-null';
import { IsTimestampString } from '../common/validation/timestamp';
import { NullIfBlank, Trim } from '../common/validation/trim';
import { CohortAdminService } from './cohort-admin.service';
import { CohortApplicationAdminService } from './cohort-application-admin.service';
import { ACTIVITY_TYPES, CohortApplicationPolicy, CohortStatusPolicy, INTEREST_AREAS } from './cohort-status';

export class CreateCohortDto {
  @Trim() @IsString() @IsNotEmpty() @MaxChars(60) name!: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(10_000) description?: string | null;
  @IsOptional() @IsTimestampString() opensAt?: string | null;
  @IsOptional() @IsTimestampString() closesAt?: string | null;
}

export class UpdateCohortDto {
  @IsOptionalNotNull() @Trim() @IsString() @IsNotEmpty() @MaxChars(60) name?: string;
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(10_000) description?: string | null;
  @IsOptional() @IsTimestampString() opensAt?: string | null;
  @IsOptional() @IsTimestampString() closesAt?: string | null;
}

export class TransitionCohortDto {
  @IsIn(CohortStatusPolicy.transitionTargets()) to!: string;
}

export class ListCohortApplicationsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(CohortApplicationPolicy.all()) status?: string;
  @IsOptional() @IsIn(ACTIVITY_TYPES) activityType?: string;
  @IsOptional() @IsIn(INTEREST_AREAS) interestArea?: string;
  /** 이름·텔레그램·트위터·닉네임·이메일 부분 일치. 이메일(320)보다 긴 검색어는 어떤 행과도 맞지 않는다 */
  @IsOptional() @Trim() @IsString() @MaxChars(320) q?: string;
}

export class ReviewCohortApplicationDto {
  @IsIn(CohortApplicationPolicy.reviewDecisions()) decision!: 'ACCEPTED' | 'REJECTED';
  @IsOptional() @NullIfBlank() @IsString() @MaxLength(2000) note?: string | null;
}

@Controller('admin')
@UseGuards(AdminGuard)
export class CohortAdminController {
  constructor(
    private readonly cohorts: CohortAdminService,
    private readonly applications: CohortApplicationAdminService,
  ) {}

  @Get('cohorts')
  list() {
    return this.cohorts.list();
  }

  @Post('cohorts')
  create(@Req() req: AuthedRequest, @Body() dto: CreateCohortDto) {
    return this.cohorts.create(req.user.userId, dto);
  }

  @Get('cohorts/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.cohorts.detail(id);
  }

  @Patch('cohorts/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: UpdateCohortDto) {
    return this.cohorts.update(id, req.user.userId, dto);
  }

  @Delete('cohorts/:id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return this.cohorts.remove(id, req.user.userId);
  }

  @Post('cohorts/:id/transition')
  transition(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: TransitionCohortDto) {
    return this.cohorts.transition(id, dto.to, req.user.userId);
  }

  /** GET /admin/cohorts/:id/applications?status=&activityType=&interestArea=&q=&page=&pageSize= */
  @Get('cohorts/:id/applications')
  listApplications(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListCohortApplicationsQueryDto) {
    return this.applications.list(id, query, query.page ?? 1, query.pageSize ?? CohortApplicationAdminService.PAGE_SIZE);
  }

  /** GET /admin/cohorts/:id/applications.csv: 같은 필터, 페이지 없음. UTF-8 BOM, 수식 주입 차단 */
  @Get('cohorts/:id/applications.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async csv(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListCohortApplicationsQueryDto) {
    return this.applications.csv(id, query);
  }

  @Post('cohort-applications/:id/review')
  review(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: ReviewCohortApplicationDto) {
    return this.applications.review(id, dto.decision, dto.note, req.user.userId);
  }
}
