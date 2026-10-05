import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';

/** 운영자용 유저 검색 및 공식 멤버 지정/해제 */
@Injectable()
export class MemberAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** 이메일/닉네임으로 유저 검색 */
  async searchUsers(q: string) {
    const r = await this.db.query(
      `SELECT u.id, u.email, u.nickname, u.status, u.is_member, u.member_role,
              u.member_display_order, u.created_at, w.address AS wallet_address
         FROM "user" u
         LEFT JOIN wallet w ON w.user_id = u.id AND w.is_primary = true AND w.disconnected_at IS NULL
        WHERE u.deleted_at IS NULL
          AND (u.email ILIKE '%' || $1 || '%' OR u.nickname ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC
        LIMIT 30`,
      [q],
    );
    return r.rows;
  }

  /** 멤버 지정/해제 + 역할/노출순서 */
  async setMember(userId: string, isMember: boolean, role?: string, displayOrder?: number, adminId?: string) {
    const r = await this.db.query(
      `UPDATE "user"
          SET is_member = $2,
              member_role = CASE WHEN $2 THEN $3::varchar ELSE NULL END,
              member_display_order = CASE WHEN $2 THEN $4::integer ELSE NULL END
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, nickname, is_member, member_role`,
      [userId, isMember, role ?? null, displayOrder ?? null],
    );
    if (!r.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    await this.audit.record(adminId, isMember ? 'USER_MEMBER_GRANTED' : 'USER_MEMBER_REVOKED', 'user', userId);
    return r.rows[0];
  }
}
