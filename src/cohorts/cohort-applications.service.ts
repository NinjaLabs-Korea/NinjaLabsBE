import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BountyActor } from '../bounties/bounty-actor';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { APPLICATION_FIELD_COLUMNS, applicantView, ApplicationFieldRow } from './cohort-application-view';
import { AnswerInputDto, hasLegacyFields, LegacyAnswerValues, normalizeOtherDetails } from './cohort-fields';
import { ApplicationAnswer, CohortQuestion, validateAnswers } from './cohort-questions';
import { CohortApplicationPolicy, CohortApplicationStatus, cohortAcceptingSql } from './cohort-status';

type OwnedRow = ApplicationFieldRow & { cohort_name: string; cohort_status: string; accepting: boolean; reviewed_at: Date | null; questions: CohortQuestion[] };

type FixedValues = { displayName: string; telegram: string; twitter: string; intro: string };
/** 생성 본문: 새 형식(answers) 또는 옛 형식(deprecated 필드). 둘 다 선택으로 받고 service 가 하나만 허용한다 */
export type ApplyInput = FixedValues & { answers?: AnswerInputDto[] } & Partial<LegacyAnswerValues>;
/** 수정 본문: 보낸 필드만 */
export type UpdateInput = Partial<FixedValues> & { answers?: AnswerInputDto[] } & Partial<LegacyAnswerValues>;

/** 한 행에 쓸 답변 칸: 새 형식은 옛 컬럼이 전부 null + answers 스냅샷, 옛 형식은 옛 컬럼 + answers [] (chk_cohort_application_answer_shape) */
type AnswerColumns = { legacy: LegacyAnswerValues | null; answers: ApplicationAnswer[] };

const bad = () => new BadRequestException('COHORT_ANSWERS_INVALID');

/** 옛 형식 본문이 셋(경력, 활동 유형, 관심 분야)을 모두 갖췄는지 보고 "기타 상세" 규칙까지 적용한다 (DB 를 건드리기 전) */
function legacyOfInput(input: ApplyInput): LegacyAnswerValues {
  if (input.web3Experience === undefined || input.activityType === undefined || input.interestAreas === undefined) throw bad();
  return normalizeOtherDetails({ ...input, web3Experience: input.web3Experience, activityType: input.activityType, interestAreas: input.interestAreas });
}

const OWNED_SELECT = `SELECT ${APPLICATION_FIELD_COLUMNS}, a.reviewed_at, c.questions,
       c.name AS cohort_name, c.status AS cohort_status, ${cohortAcceptingSql('c')} AS accepting
  FROM cohort_application a JOIN cohort c ON c.id = a.cohort_id`;

/**
 * 지원자(로그인한 유저) 쪽 기수 지원서: 지원, 내 지원 내역, 수정, 철회.
 * 상태 규칙의 출처는 cohort-status.ts. 모든 쓰기는 기수 행 잠금(FOR SHARE) 아래라 운영자의 마감/삭제 전이와 직렬화된다.
 */
@Injectable()
export class CohortApplicationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async apply(cohortId: string, userId: string, input: ApplyInput) {
    // 새 형식(answers)과 옛 형식(deprecated 필드)은 섞을 수 없다. 옛 형식은 DB 를 건드리기 전에 "기타 상세"까지 검사한다 (옛 FE 호환 경로: FE-1 배포 뒤 정리에서 지운다)
    const isNew = input.answers !== undefined;
    if (isNew && hasLegacyFields(input)) throw bad();
    const legacy = isNew ? null : legacyOfInput(input);
    return this.db.tx(async (tx) => {
      // FOR SHARE: 같은 기수에 대한 운영자 전이/삭제(UPDATE/DELETE)와 직렬화되고, 지원끼리는 서로 막지 않는다.
      // DRAFT 기수는 아직 공개 전이므로 없는 것과 같다.
      const cohort = await tx.query<{ accepting: boolean; questions: CohortQuestion[] }>(
        `SELECT ${cohortAcceptingSql('c')} AS accepting, c.questions FROM cohort c WHERE c.id = $1 AND c.status <> 'DRAFT' FOR SHARE`,
        [cohortId],
      );
      if (!cohort.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
      await BountyActor.user(userId).assertOnboarded(tx); // 409 PROFILE_REQUIRED (바운티 지원과 같은 규칙)
      if (!cohort.rows[0].accepting) throw new ConflictException('COHORT_NOT_ACCEPTING');
      // 답변은 기수 행 FOR SHARE 아래에서 검증한다: 운영자의 질문 저장(FOR UPDATE)과 직렬화돼 방금 바뀐 질문으로 검증하거나 끝난 질문으로 저장하지 않는다
      const columns: AnswerColumns = { legacy, answers: legacy ? [] : validateAnswers(cohort.rows[0].questions, input.answers ?? []) };

      const existing = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM cohort_application WHERE cohort_id = $1 AND user_id = $2 FOR UPDATE`,
        [cohortId, userId],
      );
      if (existing.rowCount) {
        if (!CohortApplicationPolicy.canReapply(existing.rows[0].status)) throw new ConflictException('COHORT_ALREADY_APPLIED');
        // 철회한 지원은 같은 행을 다시 연다 (id 유지, 심사 필드 초기화): 바운티 재지원과 같은 방식
        await tx.query(
          `UPDATE cohort_application
              SET status = $2, display_name = $3, telegram = $4, twitter = $5, intro = $6,
                  web3_experience = $7, activity_type = $8, activity_type_other = $9, interest_areas = $10::text[], interest_other = $11, answers = $12::jsonb,
                  reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, created_at = now()
            WHERE id = $1 AND status = $13`,
          [existing.rows[0].id, CohortApplicationStatus.SUBMITTED, ...this.valueParams(input, columns), CohortApplicationStatus.WITHDRAWN],
        );
        await this.audit.record(userId, 'COHORT_APPLICATION_REAPPLIED', 'cohort_application', existing.rows[0].id, tx);
        return this.owned(tx, existing.rows[0].id, userId);
      }

      let id: string;
      try {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO cohort_application
             (cohort_id, user_id, display_name, telegram, twitter, intro, web3_experience, activity_type, activity_type_other, interest_areas, interest_other, answers)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], $11, $12::jsonb)
           RETURNING id`,
          [cohortId, userId, ...this.valueParams(input, columns)],
        );
        id = r.rows[0].id;
      } catch (err: unknown) {
        // 같은 유저의 동시 POST: 둘 다 위 SELECT 에서 행이 없었다면 유니크 인덱스가 하나만 통과시킨다
        if (isUniqueViolation(err, 'uq_cohort_application_user')) throw new ConflictException('COHORT_ALREADY_APPLIED');
        throw err;
      }
      await this.audit.record(userId, 'COHORT_APPLICATION_SUBMITTED', 'cohort_application', id, tx);
      return this.owned(tx, id, userId);
    });
  }

  /** 내 지원 내역: 최신순. 심사 메모(reviewNote)는 내려보내지 않는다 */
  async mine(userId: string) {
    const r = await this.db.query<OwnedRow>(`${OWNED_SELECT} WHERE a.user_id = $1 ORDER BY a.created_at DESC, a.id`, [userId]);
    return r.rows.map(applicantView);
  }

  /**
   * 본인 지원서 수정: SUBMITTED 이고 기수가 아직 접수 중일 때만. 보낸 필드만 바꾼다.
   *  - answers 를 보내면 전체 교체: 지금 질문 기준으로 검증하고 옛 컬럼을 NULL 로 만든다 (옛 필드와 함께 보내면 400 COHORT_ANSWERS_INVALID).
   *  - answers 없이 옛 필드를 보내면 옛 형식 행만 통한다 (새 형식 행이면 400). 기존 행과 합쳐 "기타 상세" 규칙을 다시 검사한다.
   *  - 둘 다 없으면 저장된 답변을 그대로 둔다 (고쳐진 질문으로 다시 검사하지 않는다).
   */
  async update(applicationId: string, userId: string, patch: UpdateInput) {
    if (patch.answers !== undefined && hasLegacyFields(patch)) throw bad();
    return this.db.tx(async (tx) => {
      const found = await tx.query<OwnedRow>(
        `${OWNED_SELECT} WHERE a.id = $1 AND a.user_id = $2 FOR UPDATE OF a FOR SHARE OF c`,
        [applicationId, userId],
      );
      if (!found.rowCount) throw new NotFoundException('COHORT_APPLICATION_NOT_FOUND'); // 남의 지원서도 같은 404: 존재를 알리지 않는다
      const row = found.rows[0];
      if (!CohortApplicationPolicy.isEditable(row.status)) throw new ConflictException('COHORT_APPLICATION_NOT_SUBMITTED');
      if (!row.accepting) throw new ConflictException('COHORT_NOT_ACCEPTING');

      const isLegacyRow = row.web3_experience !== null;
      let columns: AnswerColumns;
      if (patch.answers !== undefined) {
        columns = { legacy: null, answers: validateAnswers(row.questions, patch.answers) };
      } else if (hasLegacyFields(patch)) {
        if (!isLegacyRow) throw bad();
        columns = {
          legacy: normalizeOtherDetails({
            web3Experience: patch.web3Experience ?? row.web3_experience as string,
            activityType: patch.activityType ?? row.activity_type as string,
            activityTypeOther: patch.activityTypeOther !== undefined ? patch.activityTypeOther : row.activity_type_other,
            interestAreas: patch.interestAreas ?? row.interest_areas as string[],
            interestOther: patch.interestOther !== undefined ? patch.interestOther : row.interest_other,
          }),
          answers: [],
        };
      } else {
        columns = isLegacyRow
          ? { legacy: { web3Experience: row.web3_experience as string, activityType: row.activity_type as string, activityTypeOther: row.activity_type_other, interestAreas: row.interest_areas as string[], interestOther: row.interest_other }, answers: [] }
          : { legacy: null, answers: row.answers };
      }
      const merged: FixedValues = {
        displayName: patch.displayName ?? row.display_name,
        telegram: patch.telegram ?? row.telegram,
        twitter: patch.twitter ?? row.twitter,
        intro: patch.intro ?? row.intro,
      };
      await tx.query(
        `UPDATE cohort_application
            SET display_name = $2, telegram = $3, twitter = $4, intro = $5,
                web3_experience = $6, activity_type = $7, activity_type_other = $8, interest_areas = $9::text[], interest_other = $10, answers = $11::jsonb
          WHERE id = $1`,
        [applicationId, ...this.valueParams(merged, columns)],
      );
      await this.audit.record(userId, 'COHORT_APPLICATION_UPDATED', 'cohort_application', applicationId, tx);
      return this.owned(tx, applicationId, userId);
    });
  }

  /** 본인 철회: SUBMITTED -> WITHDRAWN. 기수가 이미 마감됐어도 철회는 할 수 있다 */
  async withdraw(applicationId: string, userId: string) {
    return this.db.tx(async (tx) => {
      const found = await tx.query<{ status: string }>(
        `SELECT status FROM cohort_application WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [applicationId, userId],
      );
      if (!found.rowCount) throw new NotFoundException('COHORT_APPLICATION_NOT_FOUND');
      if (!CohortApplicationPolicy.isEditable(found.rows[0].status)) throw new ConflictException('COHORT_APPLICATION_NOT_SUBMITTED');
      await tx.query(`UPDATE cohort_application SET status = $2 WHERE id = $1`, [applicationId, CohortApplicationStatus.WITHDRAWN]);
      await this.audit.record(userId, 'COHORT_APPLICATION_WITHDRAWN', 'cohort_application', applicationId, tx);
      return this.owned(tx, applicationId, userId);
    });
  }

  /** 쓰기 파라미터 순서: 고정 필드 4개, 옛 컬럼 5개(새 형식이면 전부 null), answers(JSON) */
  private valueParams(fixed: FixedValues, columns: AnswerColumns): unknown[] {
    const l = columns.legacy;
    return [
      fixed.displayName, fixed.telegram, fixed.twitter, fixed.intro,
      l?.web3Experience ?? null, l?.activityType ?? null, l?.activityTypeOther ?? null, l?.interestAreas ?? null, l?.interestOther ?? null,
      JSON.stringify(columns.answers),
    ];
  }

  private async owned(tx: Pick<DatabaseService, 'query'>, applicationId: string, userId: string) {
    const r = await tx.query<OwnedRow>(`${OWNED_SELECT} WHERE a.id = $1 AND a.user_id = $2`, [applicationId, userId]);
    return applicantView(r.rows[0]);
  }
}
