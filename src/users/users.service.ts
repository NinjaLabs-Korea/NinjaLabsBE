import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { completedWinSql } from '../bounties/completed-wins';
import { DatabaseService } from '../common/database/database.service';
import { isUniqueViolation } from '../common/database/pg-errors';
import { payoutStatusSql } from '../rewards/payout-status';
import { isSavableNickname, normalizeNickname } from './nickname';
import { ownedAgentIdsSql } from '../agents/owned-agents';
import { activeUserSql } from './active-user';

/** 활성 유저 닉네임 유니크 인덱스 (0019_nickname_unicode_fold.sql, 접힌 닉네임 WHERE deleted_at IS NULL) */
export const NICKNAME_UNIQUE_INDEX = 'uq_user_nickname_active';

/**
 * 닉네임의 대소문자 접힘 SQL 식 - 위 인덱스 식과 글자 하나까지 같아야 한다 (바꾸면 마이그레이션도 새로).
 * 기본 lower()는 DB lc_ctype을 따라 C 로케일에서 `CAFÉ`/`café`를 다른 이름으로 본다. ICU collation을 명시하면 로케일과 무관하다.
 */
export const nicknameKeySql = (expr: string) => `lower(${expr} COLLATE "und-x-icu")`;

/** 닉네임을 이미 정한 사람의 다음 변경까지 기다려야 하는 시간 - 이름이 곧 신원(공개 프로필 URL, 멤버 표시)이라 빠른 양도·선점을 막는다 */
export const NICKNAME_CHANGE_COOLDOWN_HOURS = 24;
export const NICKNAME_CHANGED_AUDIT_ACTION = 'USER_NICKNAME_CHANGED';

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 닉네임 사용 가능 여부 (활성 유저 기준, 대소문자 무시) — "available"은 "지금 저장하면 받아 준다"는 뜻이다.
   * 그래서 프로필 저장과 같은 trim을 한 값으로 찾고, 저장이 거부할 값(길이·문자 규칙·예약어, 문자열이 아닌 반복 쿼리 파라미터)은
   * 조회 없이 사용 불가로 답한다 (예전에는 `" taken "`·`""`·`".ninja"`를 available로 답해 저장에서 409/400이 났다).
   */
  async nicknameAvailable(nickname: unknown): Promise<boolean> {
    if (!isSavableNickname(nickname)) return false;
    const r = await this.db.query(
      `SELECT 1 FROM "user" WHERE ${nicknameKeySql('nickname')} = ${nicknameKeySql('$1::text')} AND deleted_at IS NULL`,
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
      // 행 잠금: 같은 유저의 동시 저장 두 건이 둘 다 쿨다운 검사를 통과하지 못하게 한다 (탈퇴 경합도 여기서 0행)
      const current = await tx.query<{ nickname: string; onboarding_step: number }>(
        `SELECT nickname, onboarding_step FROM "user" WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      if (!current.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      // 프로필을 한 번 저장한 뒤(step >= 4) 닉네임이 바뀌는 경우만 제한·기록한다: 임시 닉네임에서 첫 이름을 정하거나 오타를 고치는 온보딩 재저장, 자기소개·태그만 고치는 저장은 자유.
      const previous = current.rows[0];
      const renamed = previous.onboarding_step >= 4 && previous.nickname !== nickname;
      if (renamed) {
        const recent = await tx.query(
          `SELECT 1 FROM audit_log
            WHERE action = $2 AND entity_type = 'user' AND entity_id = $1
              AND created_at > now() - make_interval(hours => $3::int)
            LIMIT 1`,
          [userId, NICKNAME_CHANGED_AUDIT_ACTION, NICKNAME_CHANGE_COOLDOWN_HOURS],
        );
        if (recent.rowCount) throw new ConflictException('NICKNAME_CHANGE_COOLDOWN');
      }
      const updated = await tx.query(
        `UPDATE "user"
            SET nickname = $2, bio = $3, onboarding_step = 4
          WHERE id = $1 AND deleted_at IS NULL`,
        [userId, nickname, bio],
      );
      // 동시 탈퇴가 먼저 커밋됐으면 0행이다 — 탈퇴자 행에 태그를 다시 심고 성공으로 답하지 않는다
      if (!updated.rowCount) throw new NotFoundException('USER_NOT_FOUND');
      if (renamed) {
        // 이전 이름은 바로 풀려 다른 사람이 가져갈 수 있다 - 누가 언제 무엇에서 무엇으로 바꿨는지 남긴다 (닉네임은 공개 정보)
        await this.audit.record(userId, NICKNAME_CHANGED_AUDIT_ACTION, 'user', userId, tx, { before: { nickname: previous.nickname }, after: { nickname } });
      }
      await tx.query(`DELETE FROM user_tag WHERE user_id = $1`, [userId]);
      for (const tag of new Set(tags)) {
        await tx.query(`INSERT INTO user_tag (user_id, tag) VALUES ($1, $2)`, [userId, tag]);
      }
      return { ok: true };
    });
  }

  /**
   * 온보딩 완료 플래그 — 프로필 저장(3단계, onboarding_step 4)을 마친 유저만. 그 전에는 임시 닉네임(`user_xxxx`)·빈 자기소개·태그 없음인 채로
   * "온보딩 완료"가 되고 공개 프로필로 노출되므로 409 PROFILE_REQUIRED. 이미 완료한 유저는 첫 완료 시각을 유지한 채 멱등.
   */
  async completeOnboarding(userId: string) {
    const stamped = await this.db.query(
      `UPDATE "user" SET onboarding_completed_at = now()
        WHERE id = $1 AND onboarding_completed_at IS NULL AND onboarding_step >= 4`,
      [userId],
    );
    if (stamped.rowCount) return { ok: true };
    const state = await this.db.query<{ done: boolean }>(
      `SELECT onboarding_completed_at IS NOT NULL AS done FROM "user" WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!state.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    if (!state.rows[0].done) throw new ConflictException('PROFILE_REQUIRED');
    return { ok: true };
  }

  /**
   * 공개 프로필 (로그인 불필요)
   * 기본 정보 + 완료 바운티 + 보유 에이전트/에이전트 완료 바운티
   * 온보딩을 마친 유저만 공개한다 - 임시 닉네임(`user_xxxx`)·빈 프로필인 가입 중 계정의 id·가입일을 닉네임만 알면 읽을 수 있었다 (404 USER_NOT_FOUND).
   */
  async publicProfile(nickname: string) {
    const user = await this.db.query(
      `SELECT u.id, u.nickname, u.bio, u.is_member, u.member_role, u.created_at,
              COALESCE(array_agg(t.tag ORDER BY t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags
         FROM "user" u
         LEFT JOIN user_tag t ON t.user_id = u.id
        WHERE ${nicknameKeySql('u.nickname')} = ${nicknameKeySql('$1::text')}
          AND ${activeUserSql('u')}
          AND u.onboarding_completed_at IS NOT NULL
        GROUP BY u.id`,
      [normalizeNickname(nickname)],
    );
    if (!user.rowCount) throw new NotFoundException('USER_NOT_FOUND');
    const u = user.rows[0];

    // 본인 + 소유 에이전트의 APPROVED 제출 (공개 프로필은 승인 기준 그대로다. highlights stats의 builders는 지급됐거나 완료된 바운티의 승인 제출자만 센다), soft delete 바운티 제외.
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
        WHERE ${completedWinSql('s', 'b')}
          AND (s.submitter_user_id = $1
               OR s.agent_id = ANY(${ownedAgentIdsSql('$1', 'live')}))
        GROUP BY s.id, b.id
        ORDER BY s.reviewed_at DESC, s.id`,
      [u.id],
    );

    // 공개 프로필에는 검증을 마친 ACTIVE 에이전트만 — PENDING_VERIFICATION(서명 없이 남의 지갑 주소를 적어 둘 수 있다)·SUSPENDED·REVOKED의
    // 이름/지갑 주소를 공개 API로 내보내지 않는다 (FE도 ACTIVE만 그린다). 폐기 전에 승인된 제출은 위 completedBounties(본인 + 소유 에이전트)에 그대로 남는다.
    // soft delete된 바운티는 공개 프로필 어디에도 나오지 않는다 (completedBounties와 같은 completedWinSql 기준을 FILTER에 건다),
    // NFT는 남기되 그 바운티 제목은 NULL이 된다 (FE는 제목 없는 NFT를 "Ninja NFT"로 보여준다)
    const agents = await this.db.query(
      `SELECT a.id, a.name, a.description, a.status, a.wallet_address,
              COALESCE(json_agg(json_build_object('id', b.id, 'title', b.title) ORDER BY s.reviewed_at DESC, b.id)
                       FILTER (WHERE ${completedWinSql('s', 'b')}), '[]') AS completed_bounties
         FROM agent a
         LEFT JOIN bounty_submission s ON s.agent_id = a.id
         LEFT JOIN bounty b ON b.id = s.bounty_id
        WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL AND a.status = 'ACTIVE'
        GROUP BY a.id
        ORDER BY a.created_at, a.id`,
      [u.id],
    );

    const nfts = await this.db.query(
      `SELECT n.id, n.nft_type, n.status, n.contract_address, n.token_id,
              n.metadata_uri, n.mint_tx_hash, n.attach_tx_hash,
              n.minted_at, n.attached_at, b.title AS bounty_title
         FROM nft n
         LEFT JOIN bounty b ON b.id = n.bounty_id AND b.deleted_at IS NULL
        WHERE n.owner_user_id = $1
        ORDER BY n.created_at, n.id`,
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
