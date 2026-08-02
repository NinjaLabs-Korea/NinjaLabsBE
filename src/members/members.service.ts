import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class MembersService {
  constructor(private readonly db: DatabaseService) {}

  /** 멤버 탭 — 공식 멤버(is_member) 리스트 (공개) */
  async list() {
    const r = await this.db.query(
      `SELECT u.id, u.nickname, u.bio, u.member_role, u.member_display_order,
              COALESCE(json_agg(json_build_object('type', l.link_type, 'url', l.url)
                       ORDER BY l.display_order)
                       FILTER (WHERE l.id IS NOT NULL), '[]') AS links
         FROM "user" u
         LEFT JOIN user_link l ON l.user_id = u.id
        WHERE u.is_member = true AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        GROUP BY u.id
        ORDER BY u.member_display_order NULLS LAST, u.created_at`,
    );
    return r.rows;
  }
}
