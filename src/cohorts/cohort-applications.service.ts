import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { BountyActor } from '../bounties/bounty-actor';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { APPLICATION_FIELD_COLUMNS, applicantView, ApplicationFieldRow } from './cohort-application-view';
import { CohortApplicationValues, normalizeOtherDetails } from './cohort-fields';
import { CohortApplicationPolicy, CohortApplicationStatus, cohortAcceptingSql } from './cohort-status';

type OwnedRow = ApplicationFieldRow & { cohort_name: string; cohort_status: string; accepting: boolean; reviewed_at: Date | null };

const OWNED_SELECT = `SELECT ${APPLICATION_FIELD_COLUMNS}, a.reviewed_at,
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

  async apply(cohortId: string, userId: string, input: Omit<CohortApplicationValues, 'activityTypeOther' | 'interestOther'> & { activityTypeOther?: string | null; interestOther?: string | null }) {
    const values = normalizeOtherDetails(input);
    return this.db.tx(async (tx) => {
      // FOR SHARE: 같은 기수에 대한 운영자 전이/삭제(UPDATE/DELETE)와 직렬화되고, 지원끼리는 서로 막지 않는다.
      // DRAFT 기수는 아직 공개 전이므로 없는 것과 같다.
      const cohort = await tx.query<{ accepting: boolean }>(
        `SELECT ${cohortAcceptingSql('c')} AS accepting FROM cohort c WHERE c.id = $1 AND c.status <> 'DRAFT' FOR SHARE`,
        [cohortId],
      );
      if (!cohort.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
      await BountyActor.user(userId).assertOnboarded(tx); // 409 PROFILE_REQUIRED (바운티 지원과 같은 규칙)
      if (!cohort.rows[0].accepting) throw new ConflictException('COHORT_NOT_ACCEPTING');

      const existing = await tx.query<{ id: string; status: string }>(
        `SELECT id, status FROM cohort_application WHERE cohort_id = $1 AND user_id = $2 FOR UPDATE`,
        [cohortId, userId],
      );
      if (existing.rowCount) {
        if (!CohortApplicationPolicy.canReapply(existing.rows[0].status)) throw new ConflictException('COHORT_ALREADY_APPLIED');
        // 철회한 지원은 같은 행을 다시 연다 (id 유지, 심사 필드 초기화): 바운티 재지원과 같은 방식
        await tx.query(
          `UPDATE cohort_application
              SET status = $2, display_name = $3, telegram = $4, twitter = $5, web3_experience = $6,
                  activity_type = $7, activity_type_other = $8, interest_areas = $9::text[], interest_other = $10, intro = $11,
                  reviewed_by = NULL, reviewed_at = NULL, review_note = NULL, created_at = now()
            WHERE id = $1 AND status = $12`,
          [existing.rows[0].id, CohortApplicationStatus.SUBMITTED, ...this.valueParams(values), CohortApplicationStatus.WITHDRAWN],
        );
        await this.audit.record(userId, 'COHORT_APPLICATION_REAPPLIED', 'cohort_application', existing.rows[0].id, tx);
        return this.owned(tx, existing.rows[0].id, userId);
      }

      let id: string;
      try {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO cohort_application
             (cohort_id, user_id, display_name, telegram, twitter, web3_experience, activity_type, activity_type_other, interest_areas, interest_other, intro)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11)
           RETURNING id`,
          [cohortId, userId, ...this.valueParams(values)],
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

  /** 본인 지원서 수정: SUBMITTED 이고 기수가 아직 접수 중일 때만. 보낸 필드만 바꾸고 기존 행과 합친 값으로 "기타 상세" 규칙을 다시 검사한다 */
  async update(applicationId: string, userId: string, patch: Partial<CohortApplicationValues>) {
    return this.db.tx(async (tx) => {
      const found = await tx.query<OwnedRow>(
        `${OWNED_SELECT} WHERE a.id = $1 AND a.user_id = $2 FOR UPDATE OF a FOR SHARE OF c`,
        [applicationId, userId],
      );
      if (!found.rowCount) throw new NotFoundException('COHORT_APPLICATION_NOT_FOUND'); // 남의 지원서도 같은 404: 존재를 알리지 않는다
      const row = found.rows[0];
      if (!CohortApplicationPolicy.isEditable(row.status)) throw new ConflictException('COHORT_APPLICATION_NOT_SUBMITTED');
      if (!row.accepting) throw new ConflictException('COHORT_NOT_ACCEPTING');

      const merged = normalizeOtherDetails({
        displayName: patch.displayName ?? row.display_name,
        telegram: patch.telegram ?? row.telegram,
        twitter: patch.twitter ?? row.twitter,
        web3Experience: patch.web3Experience ?? row.web3_experience,
        activityType: patch.activityType ?? row.activity_type,
        activityTypeOther: patch.activityTypeOther !== undefined ? patch.activityTypeOther : row.activity_type_other,
        interestAreas: patch.interestAreas ?? row.interest_areas,
        interestOther: patch.interestOther !== undefined ? patch.interestOther : row.interest_other,
        intro: patch.intro ?? row.intro,
      });
      await tx.query(
        `UPDATE cohort_application
            SET display_name = $2, telegram = $3, twitter = $4, web3_experience = $5,
                activity_type = $6, activity_type_other = $7, interest_areas = $8::text[], interest_other = $9, intro = $10
          WHERE id = $1`,
        [applicationId, ...this.valueParams(merged)],
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

  private valueParams(v: CohortApplicationValues): unknown[] {
    return [v.displayName, v.telegram, v.twitter, v.web3Experience, v.activityType, v.activityTypeOther, v.interestAreas, v.interestOther, v.intro];
  }

  private async owned(tx: Pick<DatabaseService, 'query'>, applicationId: string, userId: string) {
    const r = await tx.query<OwnedRow>(`${OWNED_SELECT} WHERE a.id = $1 AND a.user_id = $2`, [applicationId, userId]);
    return applicantView(r.rows[0]);
  }
}
