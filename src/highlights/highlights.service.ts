import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { rewardTokenDecimals } from '../rewards/reward-token-decimals';

/** 토큰별 지급 완료(PAID) 보상 합계 — amount 는 base unit 정수 문자열 (DECIMAL(78,0) 합이라 Number 로 바꾸지 않는다) */
export type PaidTotal = {
  symbol: string;
  tokenType: string;
  /** 서버가 모르는 심볼이면 null — 클라이언트는 그 항목을 표시하지 않는다 */
  decimals: number | null;
  amount: string;
};

export type HallOfFameStats = {
  completedBounties: number;
  builders: number;
  completionNfts: number;
  sponsors: number;
  /** 지급 완료 보상 총액 (토큰별). 지급 이력이 없으면 [] */
  paidTotals: PaidTotal[];
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
   * 누적 지표 — 네 개의 count 를 한 문장으로, 토큰별 지급 총액(paidTotals)을 다른 한 문장으로 (병렬) 집계하고 **인스턴스별 인메모리 캐시**에 60초(STATS_CACHE_TTL_MS) 둔다.
   * 공개 랜딩이 호출하는 경로라 트래픽이 집계 비용을 그대로 DB 에 전달했다. 지표는 운영자 전이(COMPLETED)·민팅 뒤에 바뀌는 느린 값이라
   * 최대 60초 늦게 보여도 되고(docs/api-contract.md), 캐시가 비어 있는 동안의 동시 호출은 한 번의 쿼리를 공유한다(stampede 방지).
   * 인스턴스가 여럿이면 각자 캐시를 가지므로 인스턴스마다 최대 60초 차이가 날 수 있다 — 정확한 일관성이 필요해지면 스냅샷 테이블로 전환.
   * 공개 목록과 같은 기준으로, 관리자가 삭제(soft delete)한 바운티와 그에 딸린 제출·NFT는 제외한다.
   * paidTotals 는 status = 'PAID' payout 만 더한다 — 토큰 단위가 서로 달라 bounty_reward 의 (심볼, 토큰 유형)별로 묶고 합을 base unit 문자열로 돌려준다.
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
    const [counts, paidTotals] = await Promise.all([this.computeCounts(), this.computePaidTotals()]);
    return { ...counts, paidTotals };
  }

  private async computePaidTotals(): Promise<PaidTotal[]> {
    const r = await this.db.query<{ symbol: string; token_type: string; amount: string }>(
      `SELECT upper(br.display_symbol) AS symbol, br.token_type, sum(p.amount)::text AS amount
         FROM payout p
         JOIN bounty_reward br ON br.id = p.bounty_reward_id
         JOIN bounty b ON b.id = br.bounty_id
        WHERE p.status = 'PAID' AND b.deleted_at IS NULL
        GROUP BY upper(br.display_symbol), br.token_type
        ORDER BY upper(br.display_symbol), br.token_type`,
    );
    return r.rows.map((row) => ({
      symbol: row.symbol,
      tokenType: row.token_type,
      decimals: rewardTokenDecimals(row.symbol),
      amount: row.amount,
    }));
  }

  private async computeCounts(): Promise<Omit<HallOfFameStats, 'paidTotals'>> {
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
    };
  }
}
