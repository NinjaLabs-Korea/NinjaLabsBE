import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../common/database/database.service';
import { publicBountySql } from './bounty-status';

/** 공개 상세 응답의 bounty 컬럼 — 목록(list)의 컬럼 + 본문·심사 텍스트·진행 시각 */
export const PUBLIC_DETAIL_COLUMNS = [
  'id', 'title', 'summary', 'description', 'requirements', 'evaluation_criteria', 'sponsor_name', 'category', 'status',
  'application_required', 'submission_mode', 'cover_image_url', 'max_winners',
  'application_deadline', 'submission_deadline', 'opened_at', 'review_started_at', 'completed_at', 'created_at', 'updated_at',
].map((column) => `b.${column}`).join(', ');

@Injectable()
export class BountiesService {
  constructor(private readonly db: DatabaseService) {}

  /** 공개 바운티 목록 — 한 번이라도 OPEN된 바운티만 노출 (publicBountySql: DRAFT/FUNDING_PENDING과 열리기 전에 취소된 바운티 제외) */
  async list(page = 1, pageSize = 12, category?: string, status?: string) {
    const offset = (page - 1) * pageSize;

    // 필터 조건과 파라미터를 함께 조립 (목록/카운트 쿼리에서 공유)
    const conds = [publicBountySql('b')];
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
        -- created_at, id: 동률(같은 opened_at)에서도 순서가 정해져야 LIMIT/OFFSET 페이지가 겹치거나 빠지지 않는다 (opened_at은 publicBountySql상 NULL이 아니다)
        ORDER BY b.opened_at DESC, b.created_at DESC, b.id
        LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...filterParams, pageSize, offset],
    );

    const total = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM bounty b WHERE ${where}`,
      filterParams,
    );

    return { items: items.rows, page, pageSize, total: Number(total.rows[0].count) };
  }

  /**
   * 바운티 상세 (공개) — 명시적 컬럼 목록. `b.*`는 내부 컬럼(created_by·sponsor_user_id = 운영자/유저 id, deleted_at)까지 공개 응답에 실었다.
   * FE(NinjaLabsFE src/lib/bounties.ts BountyDetailRow)가 읽는 필드는 전부 남아 있다. 새 컬럼은 공개해도 되는지 확인한 뒤 여기 추가한다.
   * 노출 조건은 목록과 같은 publicBountySql — 비공개 바운티는 없는 바운티와 같은 404다.
   */
  async detail(id: string) {
    const r = await this.db.query(
      `SELECT ${PUBLIC_DETAIL_COLUMNS},
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
        WHERE b.id = $1 AND ${publicBountySql('b')}
        GROUP BY b.id`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException('BOUNTY_NOT_FOUND');
    return r.rows[0];
  }
}
