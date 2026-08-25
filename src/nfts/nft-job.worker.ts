import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../common/database/database.service';
import { InjectiveNftClient } from './injective-nft.client';

const MAX_RETRY = 5;

/**
 * nft_job 큐 워커 — 1분마다 PENDING 잡을 집어 온체인 실행
 *
 * 실행 흐름:
 *   PENDING → PROCESSING → (온체인 tx) → SUCCEEDED / FAILED(retry_count++)
 *   MAX_RETRY 초과 시 FAILED로 고정, nft.status = FAILED → 운영자 수동 재시도
 *
 * 경로 A(표준 cw721-base): MINT_PARENT/MINT_CHILD는 mint 실행,
 * ATTACH 계열은 온체인 nest가 없으므로 DB 상태 전이만 수행한다.
 * (2팀 Nestable 컨트랙트 전환 시 InjectiveNftClient와 이 분기만 교체)
 */
@Injectable()
export class NftJobWorker {
  private readonly logger = new Logger(NftJobWorker.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly chain: InjectiveNftClient,
  ) {}

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

    if (!this.chain.isConfigured()) {
      // 컨트랙트 미배포/지갑 미설정 — 잡을 실패시키지 않고 다음 폴링으로 미룸
      await this.db.query(
        `UPDATE nft_job SET status = 'PENDING', scheduled_at = now() + interval '1 hour',
                last_error = 'NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured'
          WHERE id = $1`,
        [job.id],
      );
      return;
    }

    try {
      await this.execute(job);
      await this.db.query(
        `UPDATE nft_job SET status = 'SUCCEEDED', processed_at = now(), last_error = NULL
          WHERE id = $1`,
        [job.id],
      );
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

  private async execute(job: { id: string; nft_id: string; job_type: string }) {
    const r = await this.db.query<{
      id: string;
      nft_type: string;
      status: string;
      metadata_uri: string | null;
      owner_address: string;
    }>(
      `SELECT n.id, n.nft_type, n.status, n.metadata_uri, w.address AS owner_address
         FROM nft n JOIN wallet w ON w.id = n.owner_wallet_id
        WHERE n.id = $1`,
      [job.nft_id],
    );
    if (!r.rowCount) throw new Error(`nft ${job.nft_id} not found`);
    const nft = r.rows[0];

    switch (job.job_type) {
      case 'MINT_PARENT':
      case 'MINT_CHILD':
      case 'RETRY_MINT': {
        if (nft.status === 'MINTED' || nft.status === 'ATTACHED') return; // 멱등
        await this.db.query(`UPDATE nft SET status = 'MINTING' WHERE id = $1`, [nft.id]);
        // token_id = nft.id (UUID) — 컨트랙트 전역에서 유일
        const txHash = await this.chain.mint(nft.id, nft.owner_address, nft.metadata_uri);
        await this.db.query(
          `UPDATE nft
              SET status = 'MINTED', token_id = $2, mint_tx_hash = $3,
                  contract_address = $4, minted_at = now()
            WHERE id = $1`,
          [nft.id, nft.id, txHash, this.chain.contractAddress()],
        );
        return;
      }
      case 'ATTACH_CHILD':
      case 'RETRY_ATTACH': {
        // 표준 cw721에는 온체인 nest가 없음 — DB 상태 전이만 (Nestable 전환 시 실제 attach 호출)
        await this.db.query(
          `UPDATE nft SET status = 'ATTACHED', attached_at = now()
            WHERE id = $1 AND status IN ('MINTED', 'ATTACHING')`,
          [nft.id],
        );
        return;
      }
      default:
        throw new Error(`unknown job_type: ${job.job_type}`);
    }
  }
}
