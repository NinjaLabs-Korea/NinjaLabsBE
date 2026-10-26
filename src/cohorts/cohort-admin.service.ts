import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { CohortApplicationStatus, CohortStatus, CohortStatusPolicy, cohortAcceptingSql } from './cohort-status';

type CohortRow = {
  id: string; name: string; description: string | null; status: string; opens_at: Date | null; closes_at: Date | null;
  accepting: boolean; created_by: string; created_at: Date; updated_at: Date;
};

const COHORT_SELECT = `SELECT c.id, c.name, c.description, c.status, c.opens_at, c.closes_at, ${cohortAcceptingSql('c')} AS accepting,
       c.created_by, c.created_at, c.updated_at FROM cohort c`;

type ApplicationCounts = Record<string, number> & { total: number };

function emptyCounts(): ApplicationCounts {
  return { ...Object.fromEntries(CohortApplicationStatus_VALUES().map((status) => [status, 0])), total: 0 } as ApplicationCounts;
}
function CohortApplicationStatus_VALUES(): string[] {
  return Object.values(CohortApplicationStatus);
}

function adminView(row: CohortRow, counts: ApplicationCounts) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    acceptingApplications: row.accepting,
    /** 상태별 지원서 수 (+ total) */
    applicationCounts: counts,
    /** 지금 상태에서 운영자가 보낼 수 있는 다음 상태 (다른 OPEN 기수가 있으면 OPEN 전이는 409 COHORT_ALREADY_OPEN) */
    allowedTransitions: CohortStatusPolicy.allowedTransitions(row.status),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CohortInput = { name: string; description?: string | null; opensAt?: string | null; closesAt?: string | null };

function assertWindow(opensAt: string | Date | null, closesAt: string | Date | null): void {
  if (opensAt && closesAt && new Date(closesAt).getTime() <= new Date(opensAt).getTime()) throw new BadRequestException('COHORT_INVALID_WINDOW');
}

/** 운영자: 기수 CRUD + 상태 전이. 모든 쓰기는 같은 트랜잭션에 감사 행을 남긴다 (AuditService.record) */
@Injectable()
export class CohortAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** 전체 기수 (최신순) + 상태별 지원서 수 */
  async list() {
    const [cohorts, counts] = await Promise.all([
      this.db.query<CohortRow>(`${COHORT_SELECT} ORDER BY c.created_at DESC, c.id`),
      this.db.query<{ cohort_id: string; status: string; n: number }>(
        `SELECT cohort_id, status, count(*)::int AS n FROM cohort_application GROUP BY cohort_id, status`,
      ),
    ]);
    const byCohort = new Map<string, ApplicationCounts>();
    for (const { cohort_id, status, n } of counts.rows) {
      const c = byCohort.get(cohort_id) ?? emptyCounts();
      c[status] = n;
      c.total += n;
      byCohort.set(cohort_id, c);
    }
    return cohorts.rows.map((row) => adminView(row, byCohort.get(row.id) ?? emptyCounts()));
  }

  async detail(cohortId: string) {
    return this.view(this.db, cohortId);
  }

  async create(adminId: string, input: CohortInput) {
    assertWindow(input.opensAt ?? null, input.closesAt ?? null);
    return this.db.tx(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO cohort (name, description, opens_at, closes_at, created_by)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5) RETURNING id`,
        [input.name, input.description ?? null, input.opensAt ?? null, input.closesAt ?? null, adminId],
      );
      await this.audit.record(adminId, 'COHORT_CREATED', 'cohort', r.rows[0].id, tx);
      return this.view(tx, r.rows[0].id);
    });
  }

  /** 이름/설명/접수 기간 수정 (상태와 무관). 보낸 필드만 바꾼다: description·opensAt·closesAt 은 null 로 지울 수 있다 */
  async update(cohortId: string, adminId: string, patch: Partial<CohortInput>) {
    return this.db.tx(async (tx) => {
      const found = await tx.query<CohortRow>(`${COHORT_SELECT} WHERE c.id = $1 FOR UPDATE OF c`, [cohortId]);
      if (!found.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
      const row = found.rows[0];
      const next = {
        name: patch.name ?? row.name,
        description: patch.description !== undefined ? patch.description : row.description,
        opensAt: patch.opensAt !== undefined ? patch.opensAt : row.opens_at,
        closesAt: patch.closesAt !== undefined ? patch.closesAt : row.closes_at,
      };
      assertWindow(next.opensAt, next.closesAt);
      await tx.query(
        `UPDATE cohort SET name = $2, description = $3, opens_at = $4::timestamptz, closes_at = $5::timestamptz WHERE id = $1`,
        [cohortId, next.name, next.description, next.opensAt, next.closesAt],
      );
      await this.audit.record(adminId, 'COHORT_UPDATED', 'cohort', cohortId, tx);
      return this.view(tx, cohortId);
    });
  }

  /** 지원서가 하나라도 있으면(철회 포함) 삭제할 수 없다: 이력을 지우지 않는다 (409 COHORT_HAS_APPLICATIONS) */
  async remove(cohortId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const found = await tx.query(`SELECT 1 FROM cohort WHERE id = $1 FOR UPDATE`, [cohortId]);
      if (!found.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
      const apps = await tx.query(`SELECT 1 FROM cohort_application WHERE cohort_id = $1 LIMIT 1`, [cohortId]);
      if (apps.rowCount) throw new ConflictException('COHORT_HAS_APPLICATIONS');
      await tx.query(`DELETE FROM cohort WHERE id = $1`, [cohortId]);
      await this.audit.record(adminId, 'COHORT_DELETED', 'cohort', cohortId, tx);
      return { id: cohortId };
    });
  }

  /** DRAFT -> OPEN -> CLOSED, CLOSED -> OPEN (재오픈). OPEN 은 다른 OPEN 기수가 없을 때만 (409 COHORT_ALREADY_OPEN) */
  async transition(cohortId: string, to: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const found = await tx.query<{ status: string }>(`SELECT status FROM cohort WHERE id = $1 FOR UPDATE`, [cohortId]);
      if (!found.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
      const from = found.rows[0].status;
      if (!CohortStatusPolicy.canTransition(from, to)) throw new BadRequestException('COHORT_INVALID_TRANSITION');
      if (to === CohortStatus.OPEN) {
        const other = await tx.query(`SELECT 1 FROM cohort WHERE status = 'OPEN' AND id <> $1`, [cohortId]);
        if (other.rowCount) throw new ConflictException('COHORT_ALREADY_OPEN');
      }
      try {
        await tx.query(`UPDATE cohort SET status = $2 WHERE id = $1`, [cohortId, to]);
      } catch (err: unknown) {
        // 두 기수를 동시에 여는 경쟁: 사전 검사를 둘 다 통과해도 부분 유니크 인덱스가 하나만 허용한다
        if (isUniqueViolation(err, 'uq_cohort_single_open')) throw new ConflictException('COHORT_ALREADY_OPEN');
        throw err;
      }
      const action = to === CohortStatus.CLOSED ? 'COHORT_CLOSED' : from === CohortStatus.CLOSED ? 'COHORT_REOPENED' : 'COHORT_OPENED';
      await this.audit.record(adminId, action, 'cohort', cohortId, tx);
      return this.view(tx, cohortId);
    });
  }

  private async view(runner: Pick<DatabaseService, 'query'>, cohortId: string) {
    const [row, counts] = await Promise.all([
      runner.query<CohortRow>(`${COHORT_SELECT} WHERE c.id = $1`, [cohortId]),
      runner.query<{ status: string; n: number }>(`SELECT status, count(*)::int AS n FROM cohort_application WHERE cohort_id = $1 GROUP BY status`, [cohortId]),
    ]);
    if (!row.rowCount) throw new NotFoundException('COHORT_NOT_FOUND');
    const c = emptyCounts();
    for (const { status, n } of counts.rows) { c[status] = n; c.total += n; }
    return adminView(row.rows[0], c);
  }
}
