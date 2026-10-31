import { Body, Controller, Delete, Get, Header, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AuthedRequest } from '../auth/authed-request';
import {
  CohortQuestionsDto, CreateCohortDto, ListCohortApplicationsQueryDto, ReviewCohortApplicationDto, TransitionCohortDto, UpdateCohortDto,
} from './cohort-admin.dto';
import { CohortAdminService } from './cohort-admin.service';
import { CohortApplicationAdminService } from './cohort-application-admin.service';
import { CohortQuestionInput } from './cohort-questions';

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

  /** PUT /admin/cohorts/:id/questions: 지원서 질문 전체 교체 (상태 무관). 보낸 id 는 저장된 질문/선택지에 있어야 하고 id 가 없으면 새로 만든다 */
  @Put('cohorts/:id/questions')
  putQuestions(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: CohortQuestionsDto) {
    return this.cohorts.putQuestions(id, req.user.userId, dto.questions as CohortQuestionInput[]);
  }

  @Post('cohorts/:id/transition')
  transition(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest, @Body() dto: TransitionCohortDto) {
    return this.cohorts.transition(id, dto.to, req.user.userId);
  }

  /** GET /admin/cohorts/:id/applications?status=&questionId=&optionId=&q=&page=&pageSize= */
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
