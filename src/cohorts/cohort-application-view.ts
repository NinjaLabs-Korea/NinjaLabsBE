import { ApplicationAnswer, legacyAnswers } from './cohort-questions';
import { CohortApplicationPolicy } from './cohort-status';

/** cohort_application 행의 지원서 입력 필드 SELECT 목록 (alias a). 지원자·운영자 응답이 같은 컬럼을 쓴다 */
export const APPLICATION_FIELD_COLUMNS = `a.id, a.cohort_id, a.status, a.display_name, a.telegram, a.twitter, a.web3_experience,
       a.activity_type, a.activity_type_other, a.interest_areas, a.interest_other, a.answers, a.intro, a.created_at, a.updated_at`;

export type ApplicationFieldRow = {
  id: string; cohort_id: string; status: string; display_name: string; telegram: string; twitter: string;
  /** 옛 형식 행에만 있다 (새 형식 행은 전부 null, 답변은 answers) */
  web3_experience: string | null; activity_type: string | null; activity_type_other: string | null; interest_areas: string[] | null; interest_other: string | null;
  answers: ApplicationAnswer[]; intro: string;
  created_at: Date; updated_at: Date;
};

export function applicationFields(row: ApplicationFieldRow) {
  return {
    id: row.id,
    cohortId: row.cohort_id,
    status: row.status,
    displayName: row.display_name,
    telegram: row.telegram,
    twitter: row.twitter,
    /** 질문별 답변 (새 형식은 저장된 스냅샷, 옛 형식 행은 읽을 때 합성) */
    answers: legacyAnswers(row),
    /** @deprecated 옛 FE 호환용. 새 형식 행은 null: answers 를 쓴다 */
    web3Experience: row.web3_experience,
    /** @deprecated */
    activityType: row.activity_type,
    /** @deprecated */
    activityTypeOther: row.activity_type_other,
    /** @deprecated */
    interestAreas: row.interest_areas,
    /** @deprecated */
    interestOther: row.interest_other,
    intro: row.intro,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 지원자 본인에게 보이는 지원서: 심사 메모(review_note)·심사자는 내려보내지 않는다 (운영자 내부 메모) */
export function applicantView(row: ApplicationFieldRow & { cohort_name: string; cohort_status: string; accepting: boolean; reviewed_at: Date | null }) {
  return {
    ...applicationFields(row),
    cohort: { id: row.cohort_id, name: row.cohort_name, status: row.cohort_status, acceptingApplications: row.accepting },
    reviewedAt: row.reviewed_at,
    /** 지금 고치거나 철회할 수 있나: SUBMITTED 이고 기수가 아직 접수 중 (PATCH 규칙과 같다) */
    editable: CohortApplicationPolicy.isEditable(row.status) && row.accepting,
    withdrawable: CohortApplicationPolicy.isEditable(row.status),
  };
}
