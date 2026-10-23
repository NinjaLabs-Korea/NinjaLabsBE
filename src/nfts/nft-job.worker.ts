import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../common/database/database.service';
import { InjectiveNftClient } from './injective-nft.client';

/** 잡당 총 시도 횟수 — 첫 시도 + 재시도 4회. MAX_RETRY번째 실패에서 FAILED로 고정된다 (docs/decisions.md) */
const MAX_RETRY = 5;
/** nft_job.last_error 최대 길이 — SDK 에러는 요청 본문/스택을 통째로 담기도 한다 */
const MAX_LAST_ERROR_LENGTH = 500;
/** 이 시간보다 오래 PROCESSING인 잡은 워커 크래시로 고아가 된 것으로 보고 다시 PENDING으로 돌린다 */
const STALE_PROCESSING_INTERVAL = '15 minutes';
/** 니모닉 단어가 이 개수 이상 연달아 나오면(순서·구분자 무관) 니모닉 유출로 보고 가린다 */
const MNEMONIC_RUN = 3;
/** 32바이트 hex — secp256k1 개인키 (`0x` 접두사 유무 모두). tx 해시도 같은 모양이라 함께 가려진다 (안전 쪽으로) */
const HEX_32_BYTES = /\b(?:0x)?[0-9a-f]{64}\b/gi;

/**
 * 메시지 안에서 `words`에 속한 단어가 MNEMONIC_RUN개 이상 연속(사이에 글자 아닌 문자만)하는 구간을 `[redacted]`로 바꾼다.
 * 토큰은 글자(letter)만으로 자르므로 공백·콤마·줄바꿈·탭 등 어떤 구분자로 이어도, 순서가 뒤바뀌거나 일부만 들어 있어도 잡는다.
 */
export function redactMnemonicRuns(message: string, words: ReadonlySet<string>): string {
  const tokens = [...message.matchAll(/[A-Za-z]+/g)];
  let out = '';
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    if (!words.has(tokens[i][0].toLowerCase())) { i++; continue; }
    let j = i;
    while (j < tokens.length && words.has(tokens[j][0].toLowerCase())) j++;
    if (j - i >= MNEMONIC_RUN) {
      const start = tokens[i].index!;
      const end = tokens[j - 1].index! + tokens[j - 1][0].length;
      out += `${message.slice(cursor, start)}[redacted]`;
      cursor = end;
    }
    i = j;
  }
  return out + message.slice(cursor);
}

/**
 * nft_job 큐 워커 — 1분마다 PENDING 잡을 집어 온체인 실행
 *
 * 실행 흐름:
 *   PENDING → PROCESSING → (온체인 tx) → SUCCEEDED / PENDING(retry_count++, 10분 뒤)
 *   MAX_RETRY번째 시도까지 실패하면 FAILED로 고정, nft.status = FAILED → 운영자 수동 재시도
 *
 * 다중 인스턴스: 선점은 FOR UPDATE SKIP LOCKED 한 문장, 이후 잡별 UPDATE는 전부 `AND status = 'PROCESSING'`으로 소유를 확인한다 —
 * 고아 정리(15분)가 되돌린 잡을 다른 인스턴스가 다시 선점한 뒤 원래 인스턴스가 뒤늦게 끝내도 결과를 덮어쓰지 못한다.
 *
 * 경로 A(표준 cw721-base): MINT_PARENT/MINT_CHILD는 mint 실행,
 * ATTACH 계열은 온체인 nest가 없으므로 DB 상태 전이만 수행한다.
 * (2팀 Nestable 컨트랙트 전환 시 InjectiveNftClient와 이 분기만 교체)
 */
type ClaimedJob = { id: string; nft_id: string; job_type: string; retry_count: number; scheduled_at: Date };

@Injectable()
export class NftJobWorker {
  private readonly logger = new Logger(NftJobWorker.name);
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly chain: InjectiveNftClient,
    private readonly config: ConfigService,
  ) {}

  /**
   * DB/로그에 남길 에러 문자열 — 마스터 지갑 비밀이 들어 있으면 `[redacted]`로 바꾸고 500자로 자른다.
   *   - 니모닉 단어 3개 이상 연속 (순서·구분자 무관, 일부만 들어 있어도) — redactMnemonicRuns
   *   - 64자리 hex (개인키 모양, `0x` 유무 모두)
   * (SDK가 서명 컨텍스트를 에러 메시지에 실어 보내는 경우가 있다. 비밀은 어떤 저장소에도 남기지 않는다 — docs/security.md)
   */
  sanitizeError(err: unknown): string {
    let message = err instanceof Error ? err.message : String(err);
    const words = new Set(
      (this.config.get<string>('MASTER_WALLET_MNEMONIC') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    );
    if (words.size) message = redactMnemonicRuns(message, words);
    message = message.replace(HEX_32_BYTES, '[redacted]');
    return message.length > MAX_LAST_ERROR_LENGTH ? `${message.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…` : message;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async poll() {
    if (this.running) return; // 중복 실행 방지
    this.running = true;
    try {
      await this.requeueStaleJobs();

      // 선점(claim)을 단일 문장으로 — autocommit에서도 SELECT ... FOR UPDATE SKIP LOCKED와
      // PROCESSING 전환이 같은 스냅샷/잠금 안에서 끝나므로 워커 다중 인스턴스에도 안전
      const jobs = await this.db.query<ClaimedJob>(
        `UPDATE nft_job
            SET status = 'PROCESSING', started_at = now()
          WHERE id IN (
                SELECT id FROM nft_job
                 WHERE status = 'PENDING' AND scheduled_at <= now()
                 ORDER BY scheduled_at
                 LIMIT 10
                   FOR UPDATE SKIP LOCKED)
          RETURNING id, nft_id, job_type, retry_count, scheduled_at`,
      );

      // RETURNING 순서는 힙 순서(서브쿼리의 ORDER BY와 무관) — 오래 기다린 잡부터 처리하도록 다시 정렬한다
      const batch = [...jobs.rows].sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime());
      for (const job of batch) {
        try {
          await this.process(job);
        } catch (err) {
          // 잡 하나의 예기치 않은 오류(DB 단절 등)가 배치의 나머지를 버리게 두지 않는다 — 이 잡은 PROCESSING에 남았다가 고아 정리가 되돌린다
          this.logger.error(`nft_job ${job.id} processing threw: ${this.sanitizeError(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 고아 잡 정리 — PROCESSING 중 프로세스가 죽으면 잡이 영원히 PROCESSING에 남고 nft는 MINTING에 머문다.
   * 15분 넘게 PROCESSING인 잡을 PENDING으로 되돌리고, 그 nft 중 MINTING인 것도 PENDING으로 되돌린다
   * (실제 민팅 여부는 재실행 시 nft.status 멱등 체크가 판단한다).
   */
  private async requeueStaleJobs() {
    const stale = await this.db.query<{ id: string; nft_id: string }>(
      `UPDATE nft_job
          SET status = 'PENDING', scheduled_at = now()
        WHERE status = 'PROCESSING' AND started_at < now() - interval '${STALE_PROCESSING_INTERVAL}'
        RETURNING id, nft_id`,
    );
    if (!stale.rowCount) return;
    await this.db.query(
      `UPDATE nft SET status = 'PENDING' WHERE status = 'MINTING' AND id = ANY($1::uuid[])`,
      [stale.rows.map((row) => row.nft_id)],
    );
    this.logger.warn(
      `requeued ${stale.rowCount} stale nft_job(s) stuck in PROCESSING for over ${STALE_PROCESSING_INTERVAL}`,
    );
  }

  private async process(job: ClaimedJob) {
    // 선점 시점의 started_at은 배치 전체의 것 — 느린 배치 꼬리가 다른 인스턴스의 고아 정리(15분)에 걸리지 않도록 잡별로 다시 찍는다.
    // `status = 'PROCESSING'`이 소유 확인: 그 사이 고아 정리가 PENDING으로 되돌렸거나 다른 인스턴스가 다시 선점했으면 0행 — 내 잡이 아니다
    const owned = await this.db.query(
      `UPDATE nft_job SET started_at = now() WHERE id = $1 AND status = 'PROCESSING' RETURNING id`,
      [job.id],
    );
    if (!owned.rowCount) {
      this.logger.warn(`nft_job ${job.id} is no longer PROCESSING (requeued or claimed by another instance) — skipping`);
      return;
    }
    if (!this.chain.isConfigured()) {
      // 컨트랙트 미배포/지갑 미설정 — 잡을 실패시키지 않고 다음 폴링으로 미룸
      await this.db.query(
        `UPDATE nft_job SET status = 'PENDING', scheduled_at = now() + interval '1 hour',
                last_error = 'NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured'
          WHERE id = $1 AND status = 'PROCESSING'`,
        [job.id],
      );
      return;
    }

    try {
      await this.execute(job);
      const done = await this.db.query(
        `UPDATE nft_job SET status = 'SUCCEEDED', processed_at = now(), last_error = NULL
          WHERE id = $1 AND status = 'PROCESSING'`,
        [job.id],
      );
      if (!done.rowCount) this.logger.warn(`nft_job ${job.id} finished but was no longer PROCESSING — result not recorded by this instance`);
    } catch (err) {
      const message = this.sanitizeError(err);
      const exhausted = job.retry_count + 1 >= MAX_RETRY;
      // $2는 세 번 쓰인다 — 모두 같은 캐스트(::varchar)여야 한다. `status = $2`(varchar)와 `$2 = 'PENDING'`(text)이 섞이면 Postgres가
      // 42P08로 거부해 실패 처리 자체가 실패한다 (test-support/sql-param-casts.spec.ts가 정적으로, test-db가 실 DB로 검증)
      const recorded = await this.db.query(
        `UPDATE nft_job
            SET status = $2::varchar, retry_count = retry_count + 1, last_error = $3,
                scheduled_at = CASE WHEN $2::varchar = 'PENDING' THEN now() + interval '10 minutes' ELSE scheduled_at END,
                processed_at = CASE WHEN $2::varchar = 'FAILED' THEN now() ELSE NULL END
          WHERE id = $1 AND status = 'PROCESSING'`,
        [job.id, exhausted ? 'FAILED' : 'PENDING', message],
      );
      if (!recorded.rowCount) {
        // 다른 인스턴스가 이미 되가져간 잡 — 그쪽 결과가 유효하므로 retry_count도, nft 상태도 건드리지 않는다
        this.logger.warn(`nft_job ${job.id} failed late but was no longer PROCESSING — ignoring: ${message}`);
        return;
      }
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
      parent_nft_id: string | null;
      metadata_uri: string | null;
      owner_address: string;
    }>(
      `SELECT n.id, n.nft_type, n.status, n.parent_nft_id, n.metadata_uri, w.address AS owner_address
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
        if (nft.status !== 'MINTED' && nft.status !== 'ATTACHED') { // 이미 민팅됐으면 멱등 스킵
          await this.db.query(`UPDATE nft SET status = 'MINTING' WHERE id = $1`, [nft.id]);
          // token_id = nft.id (UUID) — 컨트랙트 전역에서 유일
          if (await this.chain.tokenExists(nft.id)) {
            // 이전 실행이 mint 브로드캐스트 직후 죽어 DB만 못 갱신한 경우 — 재민팅하면 컨트랙트가 거부하므로 DB만 복구한다.
            // tx 해시는 알 수 없으므로 mint_tx_hash(nullable)는 건드리지 않는다.
            await this.db.query(
              `UPDATE nft
                  SET status = 'MINTED', token_id = $2, contract_address = $3, minted_at = now()
                WHERE id = $1`,
              [nft.id, nft.id, this.chain.contractAddress()],
            );
            this.logger.warn(`nft ${nft.id} already minted on chain — recovered as MINTED without re-minting`);
          } else {
            const txHash = await this.chain.mint(nft.id, nft.owner_address, nft.metadata_uri);
            await this.db.query(
              `UPDATE nft
                  SET status = 'MINTED', token_id = $2, mint_tx_hash = $3,
                      contract_address = $4, minted_at = now()
                WHERE id = $1`,
              [nft.id, nft.id, txHash, this.chain.contractAddress()],
            );
          }
        }
        // 자식 NFT는 민팅 후 부모에 attach — 부모가 없으면 MINTED로 보류 (decisions.md)
        if (nft.nft_type === 'BOUNTY_COMPLETION_CHILD' && nft.parent_nft_id && nft.status !== 'ATTACHED') {
          await this.db.query(
            `INSERT INTO nft_job (nft_id, job_type, idempotency_key)
             VALUES ($1, 'ATTACH_CHILD', $2)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [nft.id, `attach-child:${nft.id}`],
          );
        }
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
