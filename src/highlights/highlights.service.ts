import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

export type HallOfFameStats = {
  completedBounties: number;
  builders: number;
  completionNfts: number;
  sponsors: number;
};

/** /hall-of-fame/stats 집계 캐시 수명 — 공개 랜딩이 매 조회마다 네 개의 count 를 돌리지 않도록 인스턴스별 인메모리로 60초 둔다 */
export const STATS_CACHE_TTL_MS = 60_000;

@Injectable()
export class HighlightsService {
  private statsCache?: { value: HallOfFameStats; expiresAt: number };
  private statsInFlight?: Promise<HallOfFameStats>;

  constructor(private readonly db: DatabaseService) {}

  /** Hall of Fame — 운영자 큐레이션 하이라이트 (공개) */
  async list() {
    const r = await this.db.query(
      `SELECT id, type, title, description, image_url, link_url, display_order, published_at
         FROM platform_highlight
        WHERE is_published = true
        ORDER BY display_order, published_at DESC`,
    );
    return r.rows;
  }

  /**
   * 누적 지표 — 네 개의 count 를 한 문장으로 집계하고 **인스턴스별 인메모리 캐시**에 60초(STATS_CACHE_TTL_MS) 둔다.
   * 공개 랜딩이 호출하는 경로라 트래픽이 집계 비용을 그대로 DB 에 전달했다. 지표는 운영자 전이(COMPLETED)·민팅 뒤에 바뀌는 느린 값이라
   * 최대 60초 늦게 보여도 되고(docs/api-contract.md), 캐시가 비어 있는 동안의 동시 호출은 한 번의 쿼리를 공유한다(stampede 방지).
   * 인스턴스가 여럿이면 각자 캐시를 가지므로 인스턴스마다 최대 60초 차이가 날 수 있다 — 정확한 일관성이 필요해지면 스냅샷 테이블로 전환.
   * 공개 목록과 같은 기준으로, 관리자가 삭제(soft delete)한 바운티와 그에 딸린 제출·NFT는 제외한다.
   * builders는 사람(submitter_user_id)과 에이전트(agent_id) 제출자를 모두 센다 (0005 chk_submission_actor: 둘 중 하나만 채워짐).
   */
  async stats(): Promise<HallOfFameStats> {
    const now = Date.now();
    if (this.statsCache && this.statsCache.expiresAt > now) return this.statsCache.value;
    if (!this.statsInFlight) {
      this.statsInFlight = this.computeStats()
        .then((value) => {
          this.statsCache = { value, expiresAt: Date.now() + STATS_CACHE_TTL_MS };
          return value;
        })
        .finally(() => { this.statsInFlight = undefined; });
    }
    return this.statsInFlight;
  }

  private async computeStats(): Promise<HallOfFameStats> {
    const r = await this.db.query<{
      completed_bounties: string;
      builders: string;
      completion_nfts: string;
      sponsors: string;
    }>(
      `SELECT
         (SELECT count(*) FROM bounty
           WHERE status = 'COMPLETED' AND deleted_at IS NULL) AS completed_bounties,
         (SELECT count(DISTINCT COALESCE(s.submitter_user_id, s.agent_id)) FROM bounty_submission s
            JOIN bounty b ON b.id = s.bounty_id
           WHERE s.status = 'APPROVED' AND b.deleted_at IS NULL) AS builders,
         (SELECT count(*) FROM nft n
            JOIN bounty b ON b.id = n.bounty_id
           WHERE n.nft_type = 'BOUNTY_COMPLETION_CHILD'
             AND n.status IN ('MINTED','ATTACHING','ATTACHED')
             AND b.deleted_at IS NULL) AS completion_nfts,
         (SELECT count(DISTINCT sponsor_name) FROM bounty
           WHERE status = 'COMPLETED' AND deleted_at IS NULL) AS sponsors`,
    );
    const s = r.rows[0];
    return {
      completedBounties: Number(s.completed_bounties),
      builders: Number(s.builders),
      completionNfts: Number(s.completion_nfts),
      sponsors: Number(s.sponsors),
      // 지급 보상 총액은 토큰별 단위가 달라 payout 조인 후 토큰별로 집계 필요 — Phase 2
    };
  }
}
