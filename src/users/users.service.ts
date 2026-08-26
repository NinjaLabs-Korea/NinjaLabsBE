import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  /** 닉네임 사용 가능 여부 (활성 유저 기준, 대소문자 무시) */
  async nicknameAvailable(nickname: string): Promise<boolean> {
    const r = await this.db.query(
      `SELECT 1 FROM "user" WHERE lower(nickname) = lower($1) AND deleted_at IS NULL`,
      [nickname],
    );
    return r.rowCount === 0;
  }

  /** 온보딩 3단계 — 프로필 저장 (닉네임/태그/자기소개 전부 필수) */
  async completeProfile(userId: string, nickname: string, bio: string, tags: string[]) {
    try {
      return await this.doCompleteProfile(userId, nickname, bio, tags);
    } catch (err: unknown) {
      // 중복검사~저장 사이 레이스: unique 인덱스가 최종 방어선
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('NICKNAME_TAKEN');
      }
      throw err;
    }
  }

  private async doCompleteProfile(userId: string, nickname: string, bio: string, tags: string[]) {
    return this.db.tx(async (tx) => {
      await tx.query(
        `UPDATE "user"
            SET nickname = $2, bio = $3, onboarding_step = 4
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId, nickname, bio],
      );
      await tx.query(`DELETE FROM user_tag WHERE user_id = $1`, [userId]);
      for (const tag of tags) {
        await tx.query(`INSERT INTO user_tag (user_id, tag) VALUES ($1, $2)`, [userId, tag]);
      }
      return { ok: true };
    });
  }

  /** 온보딩 완료 플래그 */
  async completeOnboarding(userId: string) {
    await this.db.query(
      `UPDATE "user" SET onboarding_completed_at = now()
        WHERE id = $1 AND onboarding_completed_at IS NULL`,
      [userId],
    );
    return { ok: true };
  }

  /**
   * 공개 프로필 (로그인 불필요)
   * 기본 정보 + 완료 바운티 + 보유 에이전트/에이전트 완료 바운티
   */
  async publicProfile(nickname: string) {
    const user = await this.db.query(
      `SELECT u.id, u.nickname, u.bio, u.is_member, u.member_role, u.created_at,
              COALESCE(array_agg(t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags
         FROM "user" u
         LEFT JOIN user_tag t ON t.user_id = u.id
        WHERE lower(u.nickname) = lower($1)
          AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
        GROUP BY u.id`,
      [nickname],
    );
    if (!user.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    const u = user.rows[0];

    const completedBounties = await this.db.query(
      `SELECT b.id, b.title, b.category, s.reviewed_at AS completed_at,
              COALESCE(json_agg(json_build_object(
                'amount', r.amount::text,
                'symbol', r.display_symbol
              ) ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS rewards
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id
         LEFT JOIN bounty_reward r ON r.bounty_id = b.id
        WHERE s.submitter_user_id = $1 AND s.status = 'APPROVED'
        GROUP BY s.id, b.id
        ORDER BY s.reviewed_at DESC`,
      [u.id],
    );

    const agents = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address,
              COALESCE(json_agg(json_build_object('id', b.id, 'title', b.title))
                       FILTER (WHERE b.id IS NOT NULL), '[]') AS completed_bounties
         FROM agent a
         LEFT JOIN bounty_submission s ON s.agent_id = a.id AND s.status = 'APPROVED'
         LEFT JOIN bounty b ON b.id = s.bounty_id
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
        GROUP BY a.id`,
      [u.id],
    );

    return {
      ...u,
      completedBounties: completedBounties.rows,
      agents: agents.rows,
    };
  }
}
