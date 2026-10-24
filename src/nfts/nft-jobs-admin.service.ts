import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';

/** 운영자 NFT 잡 목록이 받는 상태 — SUCCEEDED/CANCELLED는 운영 대상이 아니라 목록에서 뺀다 */
export const NFT_JOB_ADMIN_STATUSES = ['FAILED', 'PENDING', 'PROCESSING'] as const;
export type NftJobAdminStatus = (typeof NFT_JOB_ADMIN_STATUSES)[number];
export const NFT_JOB_PAGE_SIZE = 30;

/**
 * 운영자 NFT 잡 콘솔 (GET /admin/nft-jobs, POST /admin/nft-jobs/:id/retry).
 *
 * 워커(NftJobWorker)는 MAX_RETRY번째 실패에서 잡을 FAILED, nft를 FAILED로 고정한다 — 이후는 "운영자 수동 재시도".
 * 재시도는 같은 잡 행을 되살린다 (새 잡을 만들지 않는다: 멱등 키 `mint-parent:` / `mint-child:` / `attach-child:`가 이미 그 행을 가리킨다):
 *   nft_job  FAILED → PENDING, retry_count = 0, scheduled_at = now(), started_at/processed_at = NULL (last_error는 원인 확인용으로 남김)
 *   nft      FAILED → minted_at이 있으면 MINTED(attach 실패 — 이미 민팅된 토큰을 다시 민팅하지 않는다), 없으면 PENDING
 * 감사 `NFT_JOB_RETRIED`(nft_job)를 같은 트랜잭션에 남긴다. FAILED가 아닌 잡은 404 NFT_JOB_NOT_FOUND_OR_NOT_FAILED.
 */
@Injectable()
export class NftJobsAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list(filter: { status: NftJobAdminStatus; page: number }) {
    const offset = (filter.page - 1) * NFT_JOB_PAGE_SIZE;
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT j.id, j.nft_id, j.job_type, j.status, j.retry_count, j.last_error, j.scheduled_at, j.started_at,
                j.processed_at, j.created_at, j.updated_at,
                n.nft_type, n.status AS nft_status, n.bounty_id, b.title AS bounty_title, n.submission_id,
                n.owner_user_id, u.nickname AS owner_nickname, w.address AS owner_wallet_address
           FROM nft_job j
           JOIN nft n ON n.id = j.nft_id
           LEFT JOIN "user" u ON u.id = n.owner_user_id
           LEFT JOIN wallet w ON w.id = n.owner_wallet_id
           LEFT JOIN bounty b ON b.id = n.bounty_id
          WHERE j.status = $1
          ORDER BY j.updated_at DESC, j.id
          LIMIT $2 OFFSET $3`,
        [filter.status, NFT_JOB_PAGE_SIZE, offset],
      ),
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM nft_job WHERE status = $1`, [filter.status]),
    ]);
    return { items: items.rows, page: filter.page, pageSize: NFT_JOB_PAGE_SIZE, total: total.rows[0].total };
  }

  async retry(jobId: string, adminId: string) {
    return this.db.tx(async (tx) => {
      const job = await tx.query<{ id: string; nft_id: string; status: string; retry_count: number }>(
        `UPDATE nft_job
            SET status = 'PENDING', retry_count = 0, scheduled_at = now(), started_at = NULL, processed_at = NULL
          WHERE id = $1 AND status = 'FAILED'
          RETURNING id, nft_id, status, retry_count`,
        [jobId],
      );
      if (!job.rowCount) throw new NotFoundException('NFT_JOB_NOT_FOUND_OR_NOT_FAILED');
      await tx.query(
        `UPDATE nft SET status = CASE WHEN minted_at IS NOT NULL THEN 'MINTED' ELSE 'PENDING' END
          WHERE id = $1 AND status = 'FAILED'`,
        [job.rows[0].nft_id],
      );
      await this.audit.record(adminId, 'NFT_JOB_RETRIED', 'nft_job', jobId, tx);
      return job.rows[0];
    });
  }
}
