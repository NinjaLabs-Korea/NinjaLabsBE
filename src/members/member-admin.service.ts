import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { primaryWalletSql } from '../wallets/primary-wallet';

/** 운영자용 유저 검색 및 공식 멤버 지정/해제 */
@Injectable()
export class MemberAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  static readonly PAGE_SIZE = 30;

  /** ILIKE 패턴 메타문자(%, _, \)를 이스케이프 - 검색어가 와일드카드로 해석되지 않게 한다 */
  static likePattern(q: string): string {
    return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }

  /** 이메일/닉네임으로 유저 검색 - 30건씩, 빈 검색어면 최신 가입순 (FE UserDirectory가 1페이지를 "최근 30명"으로 쓴다) */
  async searchUsers(q: string, page = 1) {
    const pageSize = MemberAdminService.PAGE_SIZE;
    const r = await this.db.query(
      `SELECT u.id, u.email, u.nickname, u.status, u.is_member, u.member_role,
              u.member_display_order, u.created_at, w.address AS wallet_address
         FROM "user" u
         LEFT JOIN wallet w ON w.user_id = u.id AND ${primaryWalletSql('w')}
        WHERE u.deleted_at IS NULL
          AND (u.email ILIKE $1 ESCAPE '\\' OR u.nickname ILIKE $1 ESCAPE '\\')
        ORDER BY u.created_at DESC, u.id
        LIMIT $2 OFFSET $3`,
      [MemberAdminService.likePattern(q), pageSize, (page - 1) * pageSize],
    );
    return r.rows;
  }

  /** 멤버 지정/해제 + 역할/노출순서 - 변경과 감사 로그를 한 트랜잭션으로 */
  async setMember(userId: string, isMember: boolean, role?: string, displayOrder?: number, adminId?: string) {
    return this.db.tx(async (tx) => {
      // 지정만 막는다(해제는 언제나 가능): 온보딩을 마치지 않은 유저는 임시 닉네임·빈 프로필이고 공개 프로필(/users/:nickname)도 404라
      // 멤버 카드의 Profile 링크가 죽고 사이트맵에 404 URL이 실린다. 409 PROFILE_REQUIRED(지원·제출과 같은 코드)
      if (isMember) {
        const state = await tx.query<{ done: boolean }>(
          `SELECT onboarding_completed_at IS NOT NULL AS done FROM "user" WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
          [userId],
        );
        if (!state.rowCount) throw new NotFoundException('USER_NOT_FOUND');
        if (!state.rows[0].done) throw new ConflictException('PROFILE_REQUIRED');
      }
      const r = await tx.query(
        `UPDATE "user"
            SET is_member = $2::boolean,
                member_role = CASE WHEN $2::boolean THEN $3::varchar ELSE NULL END,
                member_display_order = CASE WHEN $2::boolean THEN $4::integer ELSE NULL END
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id, nickname, is_member, member_role`,
        [userId, isMember, role ?? null, displayOrder ?? null],
      );
      if (!r.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      await this.audit.record(adminId, isMember ? 'USER_MEMBER_GRANTED' : 'USER_MEMBER_REVOKED', 'user', userId, tx);
      return r.rows[0];
    });
  }
}
