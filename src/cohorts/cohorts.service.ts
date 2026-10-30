import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { CohortQuestion } from './cohort-questions';
import { cohortAcceptingSql } from './cohort-status';

export type PublicCohort = {
  id: string; name: string; description: string | null; opensAt: Date | null; closesAt: Date | null; acceptingApplications: boolean;
  /** 지원서 질문 (운영자가 기수마다 편집). 고정 필드(이름, 텔레그램, 트위터, 자기소개)는 포함하지 않는다 */
  questions: CohortQuestion[];
};

/** 공개: 지금 열린(OPEN) 기수 */
@Injectable()
export class CohortsService {
  constructor(private readonly db: DatabaseService) {}

  /** OPEN 기수 하나 또는 null. acceptingApplications 는 OPEN 이면서 지금이 [opens_at, closes_at] 안일 때 (아직 열기 전/마감 뒤면 false) */
  async current(): Promise<PublicCohort | null> {
    const r = await this.db.query<{ id: string; name: string; description: string | null; opens_at: Date | null; closes_at: Date | null; accepting: boolean; questions: CohortQuestion[] }>(
      `SELECT c.id, c.name, c.description, c.opens_at, c.closes_at, c.questions, ${cohortAcceptingSql('c')} AS accepting
         FROM cohort c WHERE c.status = 'OPEN'`,
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return { id: row.id, name: row.name, description: row.description, opensAt: row.opens_at, closesAt: row.closes_at, acceptingApplications: row.accepting, questions: row.questions };
  }
}
