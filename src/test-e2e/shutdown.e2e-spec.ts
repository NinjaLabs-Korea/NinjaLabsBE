import { DatabaseService } from '../common/database/database.service';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { describeDb } from '../test-db/describe-db';
import { createDb, createPrimaryWallet, createUser, deferred, waitFor } from '../test-db/harness';
import { E2eApp, startApp } from './support/harness';

/**
 * 배포 중 종료(SIGTERM → app.close())의 순서 - docs/runbook.md "배포 중 종료 순서".
 * Nest close(): onModuleDestroy → beforeApplicationShutdown(크론 정지, 워커 드레인) → HTTP 종료 → onApplicationShutdown(DB 풀 종료).
 * 예전에는 풀이 첫 단계에서 닫혀, 드레인 중인 워커와 처리 중인 요청이 "Cannot use a pool after calling end on the pool"로 실패했다.
 */
describeDb('graceful shutdown (e2e)', () => {
  let e2e: E2eApp;
  let probe: DatabaseService; // 앱 풀이 닫힌 뒤에도 결과를 읽는 별도 연결
  let closed = false;

  beforeAll(async () => {
    e2e = await startApp();
    probe = createDb();
    // 다른 파일이 남긴 대기 잡이 LIMIT 10 선점을 차지하지 않게 치운다 (파일은 직렬 실행)
    await probe.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PROCESSING')`);
  });
  afterAll(async () => {
    if (!closed) await e2e?.close();
    await probe?.onApplicationShutdown();
  });

  async function parentMintJob(scheduledAgo: string): Promise<{ nftId: string; jobId: string }> {
    const userId = await createUser(probe);
    const wallet = await createPrimaryWallet(probe, userId);
    const { nftId } = (await e2e.app.get(NftsService).enqueueParentMint(userId, wallet.id))!;
    const job = await probe.query<{ id: string }>(
      `UPDATE nft_job SET scheduled_at = now() - $2::interval WHERE nft_id = $1 RETURNING id`, [nftId, scheduledAgo]);
    return { nftId, jobId: job.rows[0].id };
  }

  async function job(id: string) {
    return (await probe.query<{ status: string; retry_count: number; started_at: Date | null }>(
      `SELECT status, retry_count, started_at FROM nft_job WHERE id = $1`, [id])).rows[0];
  }

  it('drains the in-flight NFT job on the live pool, serves requests during close, releases the rest of the batch and claims nothing new', async () => {
    const worker = e2e.app.get(NftJobWorker);
    const mintGate = deferred<string>();
    jest.spyOn(e2e.chain, 'isConfigured').mockReturnValue(true);
    const mint = jest.spyOn(e2e.chain, 'mint').mockImplementation(() => mintGate.promise);

    const first = await parentMintJob('3 seconds');
    const second = await parentMintJob('2 seconds');
    // 선점은 1분 크론이 먼저 할 수도 있다 - 어느 poll이든 첫 잡의 mint에서 멈출 때까지 찔러 본다 (겹친 poll은 건너뛴다)
    await waitFor(() => {
      void worker.poll();
      return mint.mock.calls.length > 0;
    }, 'the worker to start minting the first job');
    expect(mint.mock.calls[0][0]).toBe(first.nftId);

    // 배치를 선점한 뒤 들어온 잡 - 종료 중에는 선점되면 안 된다
    const late = await parentMintJob('1 second');

    const closing = e2e.close();
    await waitFor(() => worker['polling'].isStopping, 'shutdown to reach beforeApplicationShutdown');

    // 종료 중에도 HTTP는 살아 있고 DB 풀도 열려 있다 (예전: 503 db down)
    const health = await e2e.get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok', db: 'up' });

    await worker.poll(); // 종료 중의 크론 틱 - 아무것도 선점하지 않는다
    mintGate.resolve(`0x${'cd'.repeat(32)}`);
    await closing;
    closed = true;

    // 진행 중이던 잡은 닫히는 중의 풀로 끝까지 기록됐다
    expect((await job(first.jobId)).status).toBe('SUCCEEDED');
    const nft = (await probe.query<{ status: string }>(`SELECT status FROM nft WHERE id = $1`, [first.nftId])).rows[0];
    expect(nft.status).toBe('MINTED');
    // 손대지 않은 배치 잔여분은 PENDING으로 돌아갔다 - 시도하지 않았으니 retry_count 그대로, 15분 고아 재큐잉 대상 아님
    expect(await job(second.jobId)).toMatchObject({ status: 'PENDING', retry_count: 0 });
    // 종료 중에 들어온 잡은 선점되지 않았다
    expect(await job(late.jobId)).toMatchObject({ status: 'PENDING', retry_count: 0, started_at: null });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(e2e.linesFor('NftJobWorker').some((line) => line.includes('Cannot use a pool'))).toBe(false);
  });
});
