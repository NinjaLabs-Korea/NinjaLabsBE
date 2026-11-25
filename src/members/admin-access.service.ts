import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { activeUserSql } from '../users/active-user';

export type AdminAccessRow = { id: string; email: string; nickname: string; is_admin: boolean };

/**
 * 운영자 권한(is_admin) 부여/회수 API (`POST /admin/users/:id/admin`). scripts/grant-admin.js `applyAdminChange`와 같은 잠금 순서와
 * 마지막 운영자 규칙이다: 운영자 행 전체 FOR UPDATE(id순) -> 대상 행 FOR UPDATE -> 검사 -> UPDATE -> 감사 행, 한 트랜잭션.
 * 운영자 행을 먼저 잠그므로 동시에 두 운영자가 서로를 회수해 활성 운영자가 0명이 되는 일이 없다.
 * AdminGuard가 요청마다 DB를 다시 보므로 회수는 즉시 반영된다.
 */
@Injectable()
export class AdminAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async setAdmin(userId: string, isAdmin: boolean, actorId: string): Promise<AdminAccessRow> {
    // 자기 자신은 부여든 회수든 막는다 (스스로 잠그는 사고 방지) - DB를 보기 전에 판정한다
    if (userId === actorId) throw new ForbiddenException('ADMIN_SELF_CHANGE');
    return this.db.tx(async (tx) => {
      await tx.query(`SELECT id FROM "user" WHERE is_admin = true ORDER BY id FOR UPDATE`);
      const found = await tx.query<AdminAccessRow & { status: string; onboarded: boolean }>(
        `SELECT id, email, nickname, is_admin, status, onboarding_completed_at IS NOT NULL AS onboarded
           FROM "user" WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      if (!found.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      const target = found.rows[0];
      const current: AdminAccessRow = { id: target.id, email: target.email, nickname: target.nickname, is_admin: target.is_admin };
      if (target.is_admin === isAdmin) return current; // 이미 원하는 상태: UPDATE도 감사 행도 없다

      if (isAdmin) {
        if (target.status !== 'ACTIVE') throw new ConflictException('USER_NOT_ACTIVE');
        if (!target.onboarded) throw new ConflictException('PROFILE_REQUIRED');
      } else {
        const others = await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "user" WHERE is_admin = true AND ${activeUserSql('')} AND id <> $1::uuid`,
          [userId],
        );
        if (others.rows[0].n === 0) throw new ConflictException('LAST_ADMIN');
      }
      await tx.query(`UPDATE "user" SET is_admin = $2::boolean WHERE id = $1::uuid`, [userId, isAdmin]);
      await this.audit.record(actorId, isAdmin ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED', 'user', userId, tx, {
        before: { is_admin: !isAdmin },
        after: { is_admin: isAdmin },
      });
      return { ...current, is_admin: isAdmin };
    });
  }
}
