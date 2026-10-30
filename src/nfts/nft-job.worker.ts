import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { AlertService } from '../common/alerts/alert.service';
import { DatabaseService } from '../common/database/database.service';
import { SHUTDOWN_DRAIN_TIMEOUT_MS, SingleFlightTask } from '../common/lifecycle/single-flight-task';
import { InjectiveNftClient } from './injective-nft.client';
import { ATTACHABLE, MINT_ALREADY_DONE, NftStatus, PARENT_READY, sqlIn } from './nft-status';

/** 잡당 총 시도 횟수 — 첫 시도 + 재시도 4회. MAX_RETRY번째 실패에서 FAILED로 고정된다 (docs/decisions.md) */
const MAX_RETRY = 5;
/** nft_job.last_error 최대 길이 — SDK 에러는 요청 본문/스택을 통째로 담기도 한다 */
const MAX_LAST_ERROR_LENGTH = 500;
/** 이 시간보다 오래 PROCESSING인 잡은 워커 크래시로 고아가 된 것으로 보고 다시 PENDING으로 돌린다 */
const STALE_PROCESSING_INTERVAL = '15 minutes';
/**
 * 잡 하나의 execute() 최대 시간 — 체인 호출(mint/tokenExists)에는 앱 수준 타임아웃이 없어서, gRPC가 멈추면 poll()이 영원히 끝나지 않고
 * (한 번에 하나만 돌므로) 이 인스턴스의 민팅이 조용히 멈췄다. 넘기면 일반 실패로 기록해 10분 뒤 재시도한다.
 * 늦게 착지한 mint는 다음 시도의 tokenExists 확인이 MINTED로 복구한다. 15분 고아 기준보다 충분히 짧아야 한다.
 */
export const JOB_EXECUTION_DEADLINE_MS = 3 * 60_000;
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

/** work가 ms 안에 끝나지 않으면 message로 reject한다 (work 자체는 취소되지 않고 뒤에서 계속 돈다) */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * nft_job 큐 워커 — 1분마다 PENDING 잡을 집어 온체인 실행
 *
 * 실행 흐름:
 *   PENDING → PROCESSING → (온체인 tx) → SUCCEEDED / PENDING(retry_count++, 10분 뒤)
 *   MAX_RETRY번째 시도까지 실패하면 FAILED로 고정, nft.status = FAILED → 운영자 수동 재시도
 *
 * 다중 인스턴스: 선점은 FOR UPDATE SKIP LOCKED 한 문장, 실행마다 새 claim_token을 발급한다.
 * 잡 상태 변경과 NFT 쓰기는 같은 claim_token을 확인하므로 재선점되거나 타임아웃된 이전 실행이 결과를 덮어쓰지 못한다.
 *
 * 경로 A(표준 cw721-base): MINT_PARENT/MINT_CHILD는 mint 실행,
 * ATTACH 계열은 온체인 nest가 없으므로 DB 상태 전이만 수행한다.
 * (2팀 Nestable 컨트랙트 전환 시 InjectiveNftClient와 이 분기만 교체)
 *
 * 종료(배포): beforeApplicationShutdown에서 새 선점을 멈추고, 진행 중인 잡 하나는 끝까지 처리한 뒤, 배치에 남은 잡은 PENDING으로 돌려놓는다
 * (PROCESSING으로 남기면 15분 뒤 고아 재큐잉 알림이 배포마다 울린다). 드레인은 SHUTDOWN_DRAIN_TIMEOUT_MS까지만 기다린다.
 *
 * 부모/자식 순서: 자식은 **부모가 MINTED/ATTACHED일 때만** ATTACH_CHILD를 큐에 넣는다 — 부모가 PENDING/MINTING/FAILED이면 자식은 MINTED로
 * 머문다 (FE "포트폴리오 연결 중", decisions.md). 부모 민팅이 끝나면(MINT_PARENT 성공) 그 부모에 연결된(parent_nft_id) MINTED 자식 전부에
 * ATTACH_CHILD를 멱등 키(`attach-child:<child id>`)로 넣는다. 자식 민팅과 부모 민팅이 동시에 끝나는 경합은 자식이 MINTED가 된 **뒤에** 부모
 * 상태를 다시 읽는 것으로 닫는다 (부모는 MINTED가 된 뒤 자식을 훑으므로 어느 쪽이든 한쪽은 잡을 본다). 부모가 아직 준비되지 않은 상태에서
 * 집힌 ATTACH_CHILD(레거시 잡)는 실패/성공 처리하지 않고 1시간 뒤로 미룬다 — 성공으로 닫으면 멱등 키 때문에 다시는 attach되지 않는다.
 */
type ClaimedJob = { id: string; nft_id: string; job_type: string; retry_count: number; scheduled_at: Date; claim_token: string };
class JobClaimLostError extends Error {}
/** execute()의 결과 — 'deferred'면 잡을 성공으로 닫지 않고 PENDING으로 되돌려 나중에 다시 시도한다 */
type JobOutcome = 'done' | 'deferred';
/**
 * 선점(claim) 문장 — 한 문장 안의 FOR UPDATE SKIP LOCKED 로 다중 인스턴스가 서로 다른 잡을 집는다. test-db(nft-worker.db-spec)가
 * 두 트랜잭션에서 이 문장을 그대로 실행해 "둘 다 즉시, 서로소 집합" 을 확인하므로 워커 밖으로 꺼내 둔다.
 */
export const CLAIM_PENDING_JOBS_SQL = `UPDATE nft_job
            SET status = 'PROCESSING', started_at = now(), claim_token = gen_random_uuid()
          WHERE id IN (
                SELECT id FROM nft_job
                 WHERE status = 'PENDING' AND scheduled_at <= now()
                 ORDER BY scheduled_at
                 LIMIT 10
                   FOR UPDATE SKIP LOCKED)
          RETURNING id, nft_id, job_type, retry_count, scheduled_at, claim_token`;
/** 부모가 준비되지 않아 미룬 ATTACH_CHILD의 재시도 간격 */
const ATTACH_DEFER_INTERVAL = '1 hour';

@Injectable()
export class NftJobWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(NftJobWorker.name);
  /** poll() 중복 실행 방지 + 종료 드레인 */
  private readonly polling = new SingleFlightTask();
  /** 테스트가 줄일 수 있도록 인스턴스 필드로 둔다 */
  private readonly executionDeadlineMs = JOB_EXECUTION_DEADLINE_MS;

  constructor(
    private readonly db: DatabaseService,
    private readonly chain: InjectiveNftClient,
    private readonly config: ConfigService,
    private readonly alerts: AlertService,
  ) {}

  /**
   * DB/로그에 남길 에러 문자열 — 마스터 지갑 비밀이 들어 있으면 `[redacted]`로 바꾸고 500자로 자른다.
   *   - 니모닉 단어 3개 이상 연속 (순서·구분자 무관, 일부만 들어 있어도) — redactMnemonicRuns
   *   - 64자리 hex (개인키 모양, `0x` 유무 모두)
   *   - NUL 문자는 제거 (last_error 저장이 거부되지 않게)
   * (SDK가 서명 컨텍스트를 에러 메시지에 실어 보내는 경우가 있다. 비밀은 어떤 저장소에도 남기지 않는다 — docs/security.md)
   */
  sanitizeError(err: unknown): string {
    let message = err instanceof Error ? err.message : String(err);
    const words = new Set(
      (this.config.get<string>('MASTER_WALLET_MNEMONIC') ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    );
    if (words.size) message = redactMnemonicRuns(message, words);
    message = message.replace(HEX_32_BYTES, '[redacted]');
    // NUL은 Postgres 텍스트 컬럼이 거부한다(22021) — 실패 기록 UPDATE 자체가 실패하면 retry_count가 오르지 않아 잡이 FAILED로 못 가고 15분마다 되돌아온다
    message = message.replaceAll('\u0000', '');
    return message.length > MAX_LAST_ERROR_LENGTH ? `${message.slice(0, MAX_LAST_ERROR_LENGTH - 1)}…` : message;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async poll() {
    await this.polling.run(() => this.pollOnce());
  }

  /** 종료 훅 — 새 배치를 막고 진행 중인 배치를 기다린다. 이 훅이 끝난 뒤에야 DB 풀이 닫힌다 (DatabaseService.onApplicationShutdown) */
  async beforeApplicationShutdown() {
    const drained = await this.polling.stop();
    if (!drained) {
      this.logger.warn(
        `shutdown: nft_job batch still running after ${SHUTDOWN_DRAIN_TIMEOUT_MS / 1000}s - its current job stays PROCESSING until the ${STALE_PROCESSING_INTERVAL} stale requeue`,
      );
    }
  }

  private async pollOnce() {
    await this.requeueStaleJobs();
    if (this.polling.isStopping) return; // 종료 중 - 새로 선점하지 않는다

    // 선점(claim)을 단일 문장으로 — autocommit에서도 SELECT ... FOR UPDATE SKIP LOCKED와
    // PROCESSING 전환이 같은 스냅샷/잠금 안에서 끝나므로 워커 다중 인스턴스에도 안전
    const jobs = await this.db.query<ClaimedJob>(CLAIM_PENDING_JOBS_SQL);

    // RETURNING 순서는 힙 순서(서브쿼리의 ORDER BY와 무관) — 오래 기다린 잡부터 처리하도록 다시 정렬한다
    const batch = [...jobs.rows].sort((a, b) => a.scheduled_at.getTime() - b.scheduled_at.getTime());
    for (const [index, job] of batch.entries()) {
      if (this.polling.isStopping) {
        await this.releaseUnstarted(batch.slice(index));
        return;
      }
      try {
        await this.holdUnstarted(batch.slice(index + 1));
        await this.process(job);
      } catch (err) {
        // 잡 하나의 예기치 않은 오류(DB 단절 등)가 배치의 나머지를 버리게 두지 않는다 — 이 잡은 PROCESSING에 남았다가 고아 정리가 되돌린다
        this.logger.error(`nft_job ${job.id} processing threw: ${this.sanitizeError(err)}`);
      }
    }
  }

  /**
   * 아직 차례가 오지 않은 배치 꼬리의 started_at을 갱신한다 — 잡 하나가 최대 JOB_EXECUTION_DEADLINE_MS(3분)이므로 배치(10건)가 느리면
   * 꼬리는 선점 뒤 15분 넘게 기다릴 수 있고, 그러면 다른 인스턴스의 고아 정리가 되돌려 다시 선점한 잡을 이 인스턴스가 PROCESSING으로 보고
   * 그대로 실행해 같은 잡이 두 인스턴스에서 동시에 돈다. (id, claim_token) 쌍으로 이 배치가 소유한 잡만 갱신한다.
   */
  private async holdUnstarted(tail: ClaimedJob[]) {
    if (!tail.length) return;
    await this.db.query(
      `UPDATE nft_job SET started_at = now()
        WHERE (id, claim_token) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[])) AND status = 'PROCESSING'`,
      [tail.map((job) => job.id), tail.map((job) => job.claim_token)],
    );
  }

  /**
   * 종료 중 배치에서 아직 손대지 않은 잡을 PENDING으로 돌려놓는다 — 다음 인스턴스가 곧바로 다시 선점한다.
   * 시도하지 않았으므로 retry_count/scheduled_at은 그대로. 다른 실행이 재선점한 잡은 건드리지 않는다.
   */
  private async releaseUnstarted(jobs: ClaimedJob[]) {
    try {
      const released = await this.db.query(
        `UPDATE nft_job SET status = 'PENDING', claim_token = NULL
          WHERE (id, claim_token) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[])) AND status = 'PROCESSING'`,
        [jobs.map((job) => job.id), jobs.map((job) => job.claim_token)],
      );
      this.logger.log(`shutdown: released ${released.rowCount ?? 0} unstarted nft_job(s) back to PENDING`);
    } catch (err) {
      // 실패해도 15분 고아 정리가 되돌린다
      this.logger.error(`shutdown: could not release unstarted nft_job(s): ${this.sanitizeError(err)}`);
    }
  }

  /**
   * 고아 잡 정리 — PROCESSING 중 프로세스가 죽으면 잡이 영원히 PROCESSING에 남고 nft는 MINTING에 머문다.
   * 15분 넘게 PROCESSING인 잡을 PENDING으로 되돌리고, 그 nft 중 MINTING인 것도 PENDING으로 되돌린다
   * (실제 민팅 여부는 재실행 시 nft.status 멱등 체크가 판단한다).
   */
  private async requeueStaleJobs() {
    const stale = await this.db.tx(async (tx) => {
      const reclaimed = await tx.query<{ id: string; nft_id: string }>(
        `UPDATE nft_job
            SET status = 'PENDING', scheduled_at = now(), claim_token = NULL
          WHERE status = 'PROCESSING' AND started_at < now() - interval '${STALE_PROCESSING_INTERVAL}'
          RETURNING id, nft_id`,
      );
      if (reclaimed.rowCount) {
        // Hold the reclaimed job rows until their NFT reset commits, before a peer can claim them.
        await tx.query(
          `UPDATE nft SET status = 'PENDING' WHERE status = 'MINTING' AND id = ANY($1::uuid[])`,
          [reclaimed.rows.map((row) => row.nft_id)],
        );
      }
      return reclaimed;
    });
    if (!stale.rowCount) return;
    this.logger.warn(
      `requeued ${stale.rowCount} stale nft_job(s) stuck in PROCESSING for over ${STALE_PROCESSING_INTERVAL}`,
    );
    // 고아 잡은 워커 크래시/배포 중단의 신호 — 운영 알림 (30분 쿨다운)
    await this.alerts.notify(
      'nft-job-stale-requeue',
      `requeued ${stale.rowCount} nft_job(s) stuck in PROCESSING for over ${STALE_PROCESSING_INTERVAL} (worker crash or restart mid-job?)`,
    );
  }

  private async process(job: ClaimedJob) {
    // 선점 시점의 started_at은 배치 전체의 것 — 느린 배치 꼬리가 다른 인스턴스의 고아 정리(15분)에 걸리지 않도록 잡별로 다시 찍는다.
    // PROCESSING만으로는 다른 인스턴스의 재선점을 구분하지 못한다. 실행별 토큰까지 비교한다.
    const owned = await this.db.query(
      `UPDATE nft_job SET started_at = now() WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2 RETURNING id`,
      [job.id, job.claim_token],
    );
    if (!owned.rowCount) {
      this.logger.warn(`nft_job ${job.id} is no longer PROCESSING (requeued or claimed by another instance) - skipping`);
      return;
    }
    if (!this.chain.isConfigured()) {
      // 컨트랙트 미배포/지갑 미설정 — 잡을 실패시키지 않고 다음 폴링으로 미룸
      await this.db.query(
        `UPDATE nft_job SET status = 'PENDING', scheduled_at = now() + interval '1 hour',
                claim_token = NULL,
                last_error = 'NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured'
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
        [job.id, job.claim_token],
      );
      return;
    }

    try {
      const outcome = await withDeadline(
        this.execute(job),
        this.executionDeadlineMs,
        `nft_job execution timed out after ${this.executionDeadlineMs / 1000}s (chain call hung?)`,
      );
      if (outcome === 'deferred') {
        // 부모 NFT가 아직 준비되지 않은 ATTACH_CHILD — retry_count를 소모하지 않고 뒤로 미룬다 (성공으로 닫지 않는다: 멱등 키가 재큐잉을 막는다)
        await this.db.query(
          `UPDATE nft_job SET status = 'PENDING', scheduled_at = now() + interval '${ATTACH_DEFER_INTERVAL}',
                  claim_token = NULL,
                  last_error = 'parent NFT not minted yet - attach deferred'
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
          [job.id, job.claim_token],
        );
        this.logger.log(`nft_job ${job.id} deferred: parent NFT of ${job.nft_id} is not minted yet`);
        return;
      }
      const done = await this.db.query(
        `UPDATE nft_job SET status = 'SUCCEEDED', processed_at = now(), last_error = NULL, claim_token = NULL
          WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2`,
        [job.id, job.claim_token],
      );
      if (!done.rowCount) this.logger.warn(`nft_job ${job.id} finished but was no longer PROCESSING - result not recorded by this instance`);
    } catch (err) {
      if (err instanceof JobClaimLostError) {
        this.logger.warn(`nft_job ${job.id} claim expired - ignoring the previous attempt`);
        return;
      }
      const message = this.sanitizeError(err);
      const exhausted = job.retry_count + 1 >= MAX_RETRY;
      // $2는 세 번 쓰인다 — 모두 같은 캐스트(::varchar)여야 한다. `status = $2`(varchar)와 `$2 = 'PENDING'`(text)이 섞이면 Postgres가
      // 42P08로 거부해 실패 처리 자체가 실패한다 (test-support/sql-param-casts.spec.ts가 정적으로, test-db가 실 DB로 검증)
      const recorded = await this.db.tx(async (tx) => {
        const result = await tx.query(
          `UPDATE nft_job
              SET status = $2::varchar, retry_count = retry_count + 1, last_error = $3,
                  scheduled_at = CASE WHEN $2::varchar = 'PENDING' THEN now() + interval '10 minutes' ELSE scheduled_at END,
                  processed_at = CASE WHEN $2::varchar = 'FAILED' THEN now() ELSE NULL END,
                  claim_token = NULL
            WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $4`,
          [job.id, exhausted ? 'FAILED' : 'PENDING', message, job.claim_token],
        );
        if (result.rowCount && exhausted) {
          await tx.query(`UPDATE nft SET status = 'FAILED' WHERE id = $1`, [job.nft_id]);
        }
        return result;
      });
      if (!recorded.rowCount) {
        // 다른 인스턴스가 이미 되가져간 잡 — 그쪽 결과가 유효하므로 retry_count도, nft 상태도 건드리지 않는다
        this.logger.warn(`nft_job ${job.id} failed late but was no longer PROCESSING - ignoring: ${message}`);
        return;
      }
      if (exhausted) {
        this.logger.error(`nft_job ${job.id} failed permanently: ${message}`);
        // 운영자 수동 재시도가 필요하다 — 잡 종류별 30분 쿨다운 (체인 장애로 한꺼번에 실패해도 종류당 한 통 + 억제 건수)
        await this.alerts.notify(
          `nft-job-failed:${job.job_type}`,
          `nft_job ${job.id} (${job.job_type}, nft ${job.nft_id}) reached FAILED after ${MAX_RETRY} attempts: ${message}`,
        );
      }
    }
  }

  /** Lock the current claim through its DB effects. Chain RPCs are never awaited under this lock. */
  private async withClaim<T>(job: ClaimedJob, action: (tx: PoolClient) => Promise<T>): Promise<T> {
    return this.db.tx(async (tx) => {
      const owned = await tx.query(
        `SELECT id FROM nft_job WHERE id = $1 AND status = 'PROCESSING' AND claim_token = $2 FOR UPDATE`,
        [job.id, job.claim_token],
      );
      if (!owned.rowCount) throw new JobClaimLostError();
      return action(tx);
    });
  }

  private ownedQuery<T extends QueryResultRow = QueryResultRow>(job: ClaimedJob, sql: string, params: unknown[]): Promise<QueryResult<T>> {
    return this.withClaim(job, (tx) => tx.query<T>(sql, params));
  }

  private async execute(job: ClaimedJob): Promise<JobOutcome> {
    const r = await this.ownedQuery<{
      id: string;
      nft_type: string;
      status: string;
      parent_nft_id: string | null;
      metadata_uri: string | null;
      owner_address: string;
    }>(job,
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
        if (!MINT_ALREADY_DONE.includes(nft.status as NftStatus)) { // 이미 민팅됐으면 멱등 스킵
          await this.ownedQuery(job, `UPDATE nft SET status = 'MINTING' WHERE id = $1`, [nft.id]);
          // token_id = nft.id (UUID) — 컨트랙트 전역에서 유일
          if (await this.chain.tokenExists(nft.id)) {
            // 이전 실행이 mint 브로드캐스트 직후 죽어 DB만 못 갱신한 경우 — 재민팅하면 컨트랙트가 거부하므로 DB만 복구한다.
            // tx 해시는 알 수 없으므로 mint_tx_hash(nullable)는 건드리지 않는다.
            await this.ownedQuery(job,
              `UPDATE nft
                  SET status = 'MINTED', token_id = $2, contract_address = $3, minted_at = now()
                WHERE id = $1`,
              [nft.id, nft.id, this.chain.contractAddress()],
            );
            this.logger.warn(`nft ${nft.id} already minted on chain - recovered as MINTED without re-minting`);
          } else {
            // A slow tokenExists call may have outlived this claim. Check again before broadcasting.
            await this.withClaim(job, async () => undefined);
            const txHash = await this.chain.mint(nft.id, nft.owner_address, nft.metadata_uri);
            await this.ownedQuery(job,
              `UPDATE nft
                  SET status = 'MINTED', token_id = $2, mint_tx_hash = $3,
                      contract_address = $4, minted_at = now()
                WHERE id = $1`,
              [nft.id, nft.id, txHash, this.chain.contractAddress()],
            );
          }
        }
        if (nft.nft_type === 'NINJA_PARENT') {
          // 부모가 준비됐으니 그동안 MINTED로 기다리던 자식들을 attach — 이미 PENDING으로 미뤄진 잡은 지금 바로 돌게 당긴다
          const queued = await this.ownedQuery(job,
            `INSERT INTO nft_job (nft_id, job_type, idempotency_key)
             SELECT c.id, 'ATTACH_CHILD', 'attach-child:' || c.id
               FROM nft c
              WHERE c.parent_nft_id = $1 AND c.nft_type = 'BOUNTY_COMPLETION_CHILD' AND c.status = 'MINTED'
             ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_at = now()
             WHERE nft_job.status = 'PENDING'`,
            [nft.id],
          );
          if (queued.rowCount) this.logger.log(`parent nft ${nft.id} minted - queued ATTACH_CHILD for ${queued.rowCount} waiting child NFT(s)`);
          return 'done';
        }
        // 자식 NFT는 민팅 후 부모에 attach — 부모가 없거나 아직 MINTED/ATTACHED가 아니면 MINTED로 보류 (decisions.md).
        // 부모 상태는 자식이 MINTED가 된 뒤 다시 읽는다 (헤더 주석의 경합 참고).
        if (nft.parent_nft_id && nft.status !== 'ATTACHED' && await this.parentReady(job, nft.parent_nft_id)) {
          await this.ownedQuery(job,
            `INSERT INTO nft_job (nft_id, job_type, idempotency_key)
             VALUES ($1, 'ATTACH_CHILD', $2)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [nft.id, `attach-child:${nft.id}`],
          );
        }
        return 'done';
      }
      case 'ATTACH_CHILD':
      case 'RETRY_ATTACH': {
        if (nft.status === 'ATTACHED') return 'done'; // 멱등
        // 표준 cw721에는 온체인 nest가 없음 — DB 상태 전이만 (Nestable 전환 시 실제 attach 호출). 부모가 MINTED/ATTACHED일 때만.
        const attached = await this.ownedQuery(job,
          `UPDATE nft c SET status = 'ATTACHED', attached_at = now()
             FROM nft p
            WHERE c.id = $1 AND c.status ${sqlIn(ATTACHABLE)}
              AND p.id = c.parent_nft_id AND p.status ${sqlIn(PARENT_READY)}
            RETURNING c.id`,
          [nft.id],
        );
        if (attached.rowCount) return 'done';
        if (ATTACHABLE.includes(nft.status as NftStatus)) return 'deferred'; // 부모 미준비 - 1시간 뒤 재시도
        throw new Error(`nft ${nft.id} cannot be attached in status ${nft.status}`);
      }
      default:
        throw new Error(`unknown job_type: ${job.job_type}`);
    }
  }

  /** 부모 NFT가 자식을 받을 수 있는 상태인가 — 자식 민팅 **뒤에** 새로 읽는다 */
  private async parentReady(job: ClaimedJob, parentNftId: string): Promise<boolean> {
    const parent = await this.ownedQuery<{ status: string }>(job,
      `SELECT status FROM nft WHERE id = $1 AND nft_type = 'NINJA_PARENT'`,
      [parentNftId],
    );
    return parent.rowCount === 1 && PARENT_READY.includes(parent.rows[0].status as NftStatus);
  }
}
