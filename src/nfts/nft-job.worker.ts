import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../common/database/database.service';

const MAX_RETRY = 5;

/**
 * nft_job 큐 워커 — 1분마다 PENDING 잡을 집어 온체인 실행
 *
 * 실행 흐름:
 *   PENDING → PROCESSING → (온체인 tx) → SUCCEEDED / FAILED(retry_count++)
 *   MAX_RETRY 초과 시 FAILED로 고정, nft.status = FAILED → 운영자 수동 재시도
 *
 * TODO(Phase 3, 2팀 컨트랙트 배포 후):
 *   - @injectivelabs/sdk-ts로 MsgExecuteContract 조립
 *   - 마스터 지갑 서명 (운영: KMS/Vault, 로컬: MASTER_WALLET_MNEMONIC)
 *   - mint 성공 → nft.token_id, mint_tx_hash, minted_at 기록
 *   - attach 성공 → nft.attach_tx_hash, attached_at 기록
 */
@Injectable()
export class NftJobWorker {
  private readonly logger = new Logger(NftJobWorker.name);
  private running = false;

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async poll() {
    if (this.running) return; // 중복 실행 방지
    this.running = true;
    try {
      // FOR UPDATE SKIP LOCKED — 워커 다중 인스턴스에도 안전
      const jobs = await this.db.query<{ id: string; nft_id: string; job_type: string; retry_count: number }>(
        `SELECT id, nft_id, job_type, retry_count
           FROM nft_job
          WHERE status = 'PENDING' AND scheduled_at <= now()
          ORDER BY scheduled_at
          LIMIT 10
            FOR UPDATE SKIP LOCKED`,
      );

      for (const job of jobs.rows) {
        await this.process(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async process(job: { id: string; nft_id: string; job_type: string; retry_count: number }) {
    await this.db.query(
      `UPDATE nft_job SET status = 'PROCESSING', started_at = now() WHERE id = $1`,
      [job.id],
    );

    const contractReady = Boolean(process.env.NFT_CONTRACT_ADDRESS);
    if (!contractReady) {
      // 컨트랙트 미배포 — 잡을 실패시키지 않고 다음 폴링으로 미룸
      await this.db.query(
        `UPDATE nft_job SET status = 'PENDING', scheduled_at = now() + interval '1 hour',
                last_error = 'NFT_CONTRACT_ADDRESS not configured'
          WHERE id = $1`,
        [job.id],
      );
      return;
    }

    try {
      // TODO(Phase 3): 실제 온체인 민팅/attach 호출부
      throw new Error('on-chain execution not implemented yet');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = job.retry_count + 1 >= MAX_RETRY;
      await this.db.query(
        `UPDATE nft_job
            SET status = $2, retry_count = retry_count + 1, last_error = $3,
                scheduled_at = CASE WHEN $2 = 'PENDING' THEN now() + interval '10 minutes' ELSE scheduled_at END,
                processed_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END
          WHERE id = $1`,
        [job.id, exhausted ? 'FAILED' : 'PENDING', message],
      );
      if (exhausted) {
        await this.db.query(`UPDATE nft SET status = 'FAILED' WHERE id = $1`, [job.nft_id]);
        this.logger.error(`nft_job ${job.id} failed permanently: ${message}`);
      }
    }
  }
}
