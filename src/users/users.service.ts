import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { payoutStatusSql } from '../rewards/payout-status';
import { isSavableNickname, normalizeNickname } from './nickname';

/** 활성 유저 닉네임 유니크 인덱스 (0001_users.sql, lower(nickname) WHERE deleted_at IS NULL) */
export const NICKNAME_UNIQUE_INDEX = 'uq_user_nickname_active';

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 닉네임 사용 가능 여부 (활성 유저 기준, 대소문자 무시) — "available"은 "지금 저장하면 받아 준다"는 뜻이다.
   * 그래서 프로필 저장과 같은 trim을 한 값으로 찾고, 저장이 거부할 값(길이·문자 규칙·예약어, 문자열이 아닌 반복 쿼리 파라미터)은
   * 조회 없이 사용 불가로 답한다 (예전에는 `" taken "`·`""`·`".ninja"`를 available로 답해 저장에서 409/400이 났다).
   */
  async nicknameAvailable(nickname: unknown): Promise<boolean> {
    if (!isSavableNickname(nickname)) return false;
    const r = await this.db.query(
      `SELECT 1 FROM "user" WHERE lower(nickname) = lower($1) AND deleted_at IS NULL`,
      [normalizeNickname(nickname)],
    );
    return r.rowCount === 0;
  }

  /** 온보딩 3단계 — 프로필 저장 (닉네임/태그/자기소개 전부 필수) */
  async completeProfile(userId: string, nickname: string, bio: string, tags: string[]) {
    try {
      return await this.doCompleteProfile(userId, nickname, bio, tags);
    } catch (err: unknown) {
      // 중복검사~저장 사이 레이스: unique 인덱스가 최종 방어선. 닉네임 인덱스 충돌만 NICKNAME_TAKEN — 다른 유니크 충돌(user_tag PK 등)은 그대로 둔다
      if (isUniqueViolation(err, NICKNAME_UNIQUE_INDEX)) {
        throw new ConflictException('NICKNAME_TAKEN');
      }
      throw err;
    }
  }

  private async doCompleteProfile(userId: string, nickname: string, bio: string, tags: string[]) {
    return this.db.tx(async (tx) => {
      const updated = await tx.query(
        `UPDATE "user"
            SET nickname = $2, bio = $3, onboarding_step = 4
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId, nickname, bio],
      );
      // 동시 탈퇴가 먼저 커밋됐으면 0행이다 — 탈퇴자 행에 태그를 다시 심고 성공으로 답하지 않는다
      if (!updated.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      await tx.query(`DELETE FROM user_tag WHERE user_id = $1`, [userId]);
      for (const tag of new Set(tags)) {
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
      [normalizeNickname(nickname)],
    );
    if (!user.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    const u = user.rows[0];

    // 본인 + 소유 에이전트의 APPROVED 제출 (highlights stats의 builders 기준과 동일), soft delete 바운티 제외.
    // rewards는 바운티에 걸린 보상이 아니라 이 제출에 실제 PAID된 payout 목록이다 (금액은 최소 단위 정수 문자열).
    // postedRewards는 바운티에 걸린 보상(bounty_reward) 목록(같은 원소 모양), payoutStatus는 /submissions/me의 payment_status와 같은 SQL
    // (rewards/payout-status.ts — 이 제출에 지급될 보상 기준 PAID / PARTIALLY_PAID / PENDING / NONE). FE가 "지급 대기"를 0 INJ와 구분해 보여준다.
    const completedBounties = await this.db.query(
      `SELECT b.id, b.title, b.category, s.reviewed_at AS completed_at,
              COALESCE(json_agg(json_build_object(
                'amount', p.amount::text,
                'symbol', r.display_symbol
              ) ORDER BY p.paid_at) FILTER (WHERE p.id IS NOT NULL), '[]') AS rewards,
              COALESCE((SELECT json_agg(json_build_object('amount', rw.amount::text, 'symbol', rw.display_symbol) ORDER BY rw.created_at)
                          FROM bounty_reward rw WHERE rw.bounty_id = b.id), '[]') AS "postedRewards",
              ${payoutStatusSql('s', 'b')} AS "payoutStatus"
         FROM bounty_submission s
         JOIN bounty b ON b.id = s.bounty_id
         LEFT JOIN payout p ON p.submission_id = s.id AND p.status = 'PAID'
         LEFT JOIN bounty_reward r ON r.id = p.bounty_reward_id
        WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL
          AND (s.submitter_user_id = $1
               OR s.agent_id = ANY(ARRAY(SELECT id FROM agent WHERE owner_user_id = $1 AND deleted_at IS NULL)))
        GROUP BY s.id, b.id
        ORDER BY s.reviewed_at DESC`,
      [u.id],
    );

    // soft delete된 바운티는 공개 프로필 어디에도 나오지 않는다 (completedBounties와 같은 기준) — JOIN 조건에 두어 FILTER가 그 행을 버리고,
    // NFT는 남기되 그 바운티 제목은 NULL이 된다 (FE는 제목 없는 NFT를 "Ninja NFT"로 보여준다)
    const agents = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address,
              COALESCE(json_agg(json_build_object('id', b.id, 'title', b.title))
                       FILTER (WHERE b.id IS NOT NULL), '[]') AS completed_bounties
         FROM agent a
         LEFT JOIN bounty_submission s ON s.agent_id = a.id AND s.status = 'APPROVED'
         LEFT JOIN bounty b ON b.id = s.bounty_id AND b.deleted_at IS NULL
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL
        GROUP BY a.id`,
      [u.id],
    );

    const nfts = await this.db.query(
      `SELECT n.id, n.nft_type, n.status, n.contract_address, n.token_id,
              n.metadata_uri, n.mint_tx_hash, n.attach_tx_hash,
              n.minted_at, n.attached_at, b.title AS bounty_title
         FROM nft n
         LEFT JOIN bounty b ON b.id = n.bounty_id AND b.deleted_at IS NULL
        WHERE n.owner_user_id = $1
        ORDER BY n.created_at`,
      [u.id],
    );

    return {
      ...u,
      completedBounties: completedBounties.rows,
      agents: agents.rows,
      nfts: nfts.rows,
    };
  }
}
