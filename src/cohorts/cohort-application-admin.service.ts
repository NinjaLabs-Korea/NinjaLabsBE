import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { MemberAdminService } from '../members/member-admin.service';
import { APPLICATION_FIELD_COLUMNS, applicationFields, ApplicationFieldRow } from './cohort-application-view';
import { toCsv } from './cohort-csv';
import { answerCsvCells, CohortQuestion, legacyAnswers } from './cohort-questions';
import { CohortApplicationPolicy, CohortReviewDecision } from './cohort-status';

/**
 * questionId + optionId 는 둘 다 있을 때만 필터가 된다 (답변 스냅샷 또는 옛 컬럼에서 찾는다).
 * activityType / interestArea 는 옛 운영 화면용 별칭이다: interestArea=X == questionId=interest_areas&optionId=X.
 */
export type ApplicationFilter = { status?: string; questionId?: string; optionId?: string; activityType?: string; interestArea?: string; q?: string };

type AdminRow = ApplicationFieldRow & {
  review_note: string | null; reviewed_by: string | null; reviewed_at: Date | null;
  user_id: string; nickname: string; email: string;
};

const ADMIN_SELECT = `SELECT ${APPLICATION_FIELD_COLUMNS}, a.review_note, a.reviewed_by, a.reviewed_at,
       a.user_id, u.nickname, u.email
  FROM cohort_application a JOIN "user" u ON u.id = a.user_id`;

function adminApplication(row: AdminRow) {
  return {
    ...applicationFields(row),
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    user: { id: row.user_id, nickname: row.nickname, email: row.email },
  };
}

/** CSV 머리글: 고정 9칸 + 현재 질문마다 한 칸(label.ko) + 현재 질문에 없는 답변 + 심사 */
export const CSV_FIXED_HEADER = ['id', 'applied_at', 'status', 'display_name', 'nickname', 'email', 'telegram', 'twitter', 'intro'] as const;
export const CSV_TAIL_HEADER = ['other_answers', 'review_note', 'reviewed_at'] as const;
export const csvHeader = (questions: readonly CohortQuestion[]): string[] => [...CSV_FIXED_HEADER, ...questions.map((q) => q.label.ko), ...CSV_TAIL_HEADER];

/** 운영자: 기수별 지원서 목록/검색/CSV 와 심사 */
@Injectable()
export class CohortApplicationAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  static readonly PAGE_SIZE = 30;

  /** 필터는 파라미터 바인딩으로만 조립한다. params[0] 은 cohort id */
  private where(cohortId: string, filter: ApplicationFilter): { sql: string; params: unknown[] } {
    const params: unknown[] = [cohortId];
    const conds = ['a.cohort_id = $1'];
    if (filter.status) { params.push(filter.status); conds.push(`a.status = $${params.length}`); }
    const choiceFilters: [string, string][] = [];
    if (filter.questionId && filter.optionId) choiceFilters.push([filter.questionId, filter.optionId]);
    if (filter.interestArea) choiceFilters.push(['interest_areas', filter.interestArea]);
    if (filter.activityType) choiceFilters.push(['activity_type', filter.activityType]);
    for (const [questionId, optionId] of choiceFilters) {
      params.push(questionId, optionId);
      const qn = `$${params.length - 1}::text`;
      const on = `$${params.length}::text`;
      // 새 형식은 답변 스냅샷에서, 옛 형식 행은 옛 컬럼에서 같은 (질문 id, 선택지 id) 로 찾는다
      conds.push(`(a.answers @> jsonb_build_array(jsonb_build_object('questionId', ${qn}, 'choices', jsonb_build_array(jsonb_build_object('id', ${on}))))
                   OR (${qn} = 'web3_experience' AND a.web3_experience = ${on})
                   OR (${qn} = 'interest_areas' AND ${on} = ANY(a.interest_areas))
                   OR (${qn} = 'activity_type' AND a.activity_type = ${on}))`);
    }
    if (filter.q) {
      params.push(MemberAdminService.likePattern(filter.q));
      const n = `$${params.length}`;
      conds.push(`(a.display_name ILIKE ${n} ESCAPE '\\' OR a.telegram ILIKE ${n} ESCAPE '\\' OR a.twitter ILIKE ${n} ESCAPE '\\'
                   OR u.nickname ILIKE ${n} ESCAPE '\\' OR u.email ILIKE ${n} ESCAPE '\\')`);
    }
    return { sql: conds.join(' AND '), params };
  }

  /** 기수가 있어야 한다 (404 COHORT_NOT_FOUND). 현재 질문을 돌려준다 (CSV 머리글) */
  private async assertCohort(cohortId: string): Promise<CohortQuestion[]> {
    const r = await this.db.query<{ questions: CohortQuestion[] }>(`SELECT questions FROM cohort WHERE id = $1`, [cohortId]);
    if (!r.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
    return r.rows[0].questions;
  }

  async list(cohortId: string, filter: ApplicationFilter, page = 1, pageSize = ApplicationAdminPageSize()) {
    await this.assertCohort(cohortId);
    const { sql, params } = this.where(cohortId, filter);
    const [items, total] = await Promise.all([
      this.db.query<AdminRow>(
        `${ADMIN_SELECT} WHERE ${sql}
          ORDER BY a.created_at DESC, a.id -- 동률에서도 페이지가 겹치지 않게
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pageSize, (page - 1) * pageSize],
      ),
      this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM cohort_application a JOIN "user" u ON u.id = a.user_id WHERE ${sql}`, params),
    ]);
    return { items: items.rows.map(adminApplication), page, pageSize, total: total.rows[0].n };
  }

  /** CSV 본문 (BOM 포함). 목록과 같은 필터, 페이지 없이 전부 */
  async csv(cohortId: string, filter: ApplicationFilter): Promise<string> {
    const questions = await this.assertCohort(cohortId);
    const { sql, params } = this.where(cohortId, filter);
    const r = await this.db.query<AdminRow>(`${ADMIN_SELECT} WHERE ${sql} ORDER BY a.created_at DESC, a.id`, params);
    // 텔레그램/트위터는 `@` 없이 내보낸다: 모든 핸들이 `@`로 시작해 수식 차단 접두사가 전 행에 붙는 것을 피한다 (핸들 규칙상 첫 글자는 영문/숫자/_ 라 안전)
    const bare = (handle: string) => handle.replace(/^@/, '');
    return toCsv(csvHeader(questions), r.rows.map((row) => {
      const { cells, otherAnswers } = answerCsvCells(questions, legacyAnswers(row));
      return [
        row.id, row.created_at, row.status, row.display_name, row.nickname, row.email, bare(row.telegram), bare(row.twitter), row.intro,
        ...cells, otherAnswers, row.review_note, row.reviewed_at,
      ];
    }));
  }

  /**
   * 심사 (ACCEPTED / REJECTED). SUBMITTED 뿐 아니라 이미 결정된 지원서의 결정 변경도 허용한다. 철회된 지원서는 409 COHORT_APPLICATION_WITHDRAWN.
   * 메모는 결정마다 새로 받는다 (바꾼 결정에 이전 결정의 사유가 남지 않게). 감사 행에는 이전/이후 상태를 남긴다.
   * 합격은 멤버 지정이 아니다 (user.is_member 를 건드리지 않는다).
   */
  async review(applicationId: string, decision: CohortReviewDecision, note: string | null | undefined, adminId: string) {
    return this.db.tx(async (tx) => {
      const found = await tx.query<{ status: string }>(`SELECT status FROM cohort_application WHERE id = $1 FOR UPDATE`, [applicationId]);
      if (!found.rowCount) throw new NotFoundException('COHORT_APPLICATION_NOT_FOUND');
      const before = found.rows[0].status;
      if (!CohortApplicationPolicy.isReviewable(before)) throw new ConflictException('COHORT_APPLICATION_WITHDRAWN');
      await tx.query(
        `UPDATE cohort_application SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
        [applicationId, decision, note ?? null, adminId],
      );
      await this.audit.record(adminId, `COHORT_APPLICATION_${decision}`, 'cohort_application', applicationId, tx, { before: { status: before }, after: { status: decision } });
      const r = await tx.query<AdminRow>(`${ADMIN_SELECT} WHERE a.id = $1`, [applicationId]);
      return adminApplication(r.rows[0]);
    });
  }
}

function ApplicationAdminPageSize(): number {
  return CohortApplicationAdminService.PAGE_SIZE;
}
