import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';

@Injectable()
export class BountiesService {
  constructor(private readonly db: DatabaseService) {}

  /** 공개 바운티 목록 — OPEN 이후 상태만 노출 (DRAFT/FUNDING_PENDING 제외) */
  async list(page = 1, pageSize = 12, category?: string, status?: string) {
    const offset = (page - 1) * pageSize;

    // 필터 조건과 파라미터를 함께 조립 (목록/카운트 쿼리에서 공유)
    const conds = [`b.deleted_at IS NULL`, `b.status NOT IN ('DRAFT', 'FUNDING_PENDING')`];
    const filterParams: unknown[] = [];
    if (category) {
      filterParams.push(category);
      conds.push(`b.category = $${filterParams.length}`);
    }
    if (status) {
      filterParams.push(status);
      conds.push(`b.status = $${filterParams.length}`);
    }
    const where = conds.join(' AND ');
    const n = filterParams.length;

    const items = await this.db.query(
      `SELECT b.id, b.title, b.summary, b.sponsor_name, b.category, b.status,
              b.application_required, b.submission_mode, b.cover_image_url, b.max_winners,
              b.application_deadline, b.submission_deadline, b.opened_at,
              COALESCE(json_agg(json_build_object(
                'symbol', r.display_symbol, 'amount', r.amount::text, 'tokenType', r.token_type,
                'tokenContractAddress', r.token_contract_address, 'evmChainId', r.evm_chain_id
              )) FILTER (WHERE r.id IS NOT NULL), '[]') AS rewards
         FROM bounty b
         LEFT JOIN bounty_reward r ON r.bounty_id = b.id
        WHERE ${where}
        GROUP BY b.id
        ORDER BY b.opened_at DESC NULLS LAST
        LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...filterParams, pageSize, offset],
    );

    const total = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM bounty b WHERE ${where}`,
      filterParams,
    );

    return { items: items.rows, page, pageSize, total: Number(total.rows[0].count) };
  }

  /** 바운티 상세 (공개) */
  async detail(id: string) {
    const r = await this.db.query(
      `SELECT b.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'symbol', rw.display_symbol, 'amount', rw.amount::text,
                'tokenType', rw.token_type, 'tokenContractAddress', rw.token_contract_address,
                'evmChainId', rw.evm_chain_id, 'status', rw.status
              )) FILTER (WHERE rw.id IS NOT NULL), '[]') AS rewards,
              COALESCE(json_agg(DISTINCT jsonb_build_object(
                'id', a.id, 'fileName', a.file_name, 'fileUrl', a.file_url
              )) FILTER (WHERE a.id IS NOT NULL), '[]') AS attachments
         FROM bounty b
         LEFT JOIN bounty_reward rw ON rw.bounty_id = b.id
         LEFT JOIN bounty_attachment a ON a.bounty_id = b.id
        WHERE b.id = $1 AND b.deleted_at IS NULL
          AND b.status NOT IN ('DRAFT', 'FUNDING_PENDING')
        GROUP BY b.id`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    return r.rows[0];
  }
}
