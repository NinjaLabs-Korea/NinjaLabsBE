import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class HighlightsService {
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

  /** 누적 지표 — 실시간 집계 (트래픽 증가 시 캐시/스냅샷으로 전환) */
  async stats() {
    const r = await this.db.query<{
      completed_bounties: string;
      builders: string;
      completion_nfts: string;
      sponsors: string;
    }>(
      `SELECT
         (SELECT count(*) FROM bounty WHERE status = 'COMPLETED') AS completed_bounties,
         (SELECT count(DISTINCT submitter_user_id) FROM bounty_submission WHERE status = 'APPROVED') AS builders,
         (SELECT count(*) FROM nft WHERE nft_type = 'BOUNTY_COMPLETION_CHILD' AND status IN ('MINTED','ATTACHING','ATTACHED')) AS completion_nfts,
         (SELECT count(DISTINCT sponsor_name) FROM bounty WHERE status = 'COMPLETED') AS sponsors`,
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
