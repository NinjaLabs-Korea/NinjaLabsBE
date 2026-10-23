import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, testConfig } from './harness';

// 실제 클라이언트는 @injectivelabs/sdk-ts(ESM)를 끌어오므로 DI 메타데이터용 껍데기로 대체한다 (유닛 스펙과 동일)
jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

type JobRow = { status: string; retry_count: number; last_error: string | null; scheduled_at: Date; processed_at: Date | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * NftJobWorker on a real database — 실패 경로 UPDATE의 `$2` 세 자리(컬럼 대입 + 문자열 비교 2곳)는 mock DB에서는 통과하고
 * 실 Postgres에서만 42P08을 내던 자리다. 여기서는 진짜 nft_job/nft 행 위에서 재시도·FAILED 경계·배치 격리·다중 인스턴스 소유권을 본다.
 */
describeDb('nft_job worker on a real database', () => {
  let db: DatabaseService;
  let nfts: NftsService;

  beforeAll(async () => {
    db = createDb();
    nfts = new NftsService(db, testConfig());
    // 다른 스위트가 남긴 대기 잡이 LIMIT 10 선점을 차지하지 않도록 치운다 (스위트는 직렬 실행 — 그쪽 단언은 이미 끝났다)
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PROCESSING')`);
  });
  afterAll(async () => db.onModuleDestroy());

  function chainStub(mint: (tokenId: string) => Promise<string>) {
    return {
      isConfigured: () => true,
      contractAddress: () => 'inj1testcontract',
      tokenExists: jest.fn(async () => false),
      mint: jest.fn(mint),
    };
  }

  function createWorker(chain: ReturnType<typeof chainStub>): NftJobWorker {
    const worker = new NftJobWorker(db, chain as unknown as InjectiveNftClient, testConfig());
    jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    return worker;
  }

  /** 부모 NFT + MINT_PARENT 잡 (지갑 연결 직후 상태). `scheduledAgo`로 배치 안 처리 순서를 고정한다 */
  async function parentJob(scheduledAgo: string): Promise<{ nftId: string; jobId: string }> {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const job = await db.query<{ id: string }>(
      `UPDATE nft_job SET scheduled_at = now() - $2::interval WHERE nft_id = $1 RETURNING id`, [nftId, scheduledAgo]);
    return { nftId, jobId: job.rows[0].id };
  }

  async function jobRow(id: string): Promise<JobRow> {
    const r = await db.query<JobRow>(
      `SELECT status, retry_count, last_error, scheduled_at, processed_at FROM nft_job WHERE id = $1`, [id]);
    return r.rows[0];
  }

  async function nftRow(id: string) {
    const r = await db.query<{ status: string; token_id: string | null; mint_tx_hash: string | null }>(
      `SELECT status, token_id, mint_tx_hash FROM nft WHERE id = $1`, [id]);
    return r.rows[0];
  }

  it('a rejected mint schedules a retry (+1, +10min, last_error) and a healthy job later in the same batch still succeeds', async () => {
    const failing = await parentJob('2 minutes');
    const healthy = await parentJob('1 minute');
    const chain = chainStub(async (tokenId) => {
      if (tokenId === failing.nftId) throw new Error('mint rejected: insufficient funds');
      return '0xhealthy';
    });
    const before = Date.now();
    await createWorker(chain).poll();

    // the failing job was processed first (older scheduled_at) and did not abort the batch
    expect(chain.mint.mock.calls.map(([tokenId]) => tokenId)).toEqual([failing.nftId, healthy.nftId]);

    const retried = await jobRow(failing.jobId);
    expect(retried).toMatchObject({ status: 'PENDING', retry_count: 1, last_error: 'mint rejected: insufficient funds', processed_at: null });
    const delay = retried.scheduled_at.getTime() - before;
    expect(delay).toBeGreaterThan(9.5 * 60_000);
    expect(delay).toBeLessThan(10.5 * 60_000);
    expect((await nftRow(failing.nftId)).status).not.toBe('FAILED');

    expect(await jobRow(healthy.jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null, processed_at: expect.any(Date) });
    expect(await nftRow(healthy.nftId)).toEqual({ status: 'MINTED', token_id: healthy.nftId, mint_tx_hash: '0xhealthy' });
  });

  it('the 4th failed attempt still retries; the 5th (MAX_RETRY) marks the job and the nft FAILED', async () => {
    const { nftId, jobId } = await parentJob('1 minute');
    const chain = chainStub(async () => { throw new Error('node unreachable'); });
    const worker = createWorker(chain);

    await db.query(`UPDATE nft_job SET retry_count = 3 WHERE id = $1`, [jobId]);
    await worker.poll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'PENDING', retry_count: 4, processed_at: null });
    expect((await nftRow(nftId)).status).not.toBe('FAILED');

    await db.query(`UPDATE nft_job SET scheduled_at = now() WHERE id = $1`, [jobId]);
    await worker.poll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'FAILED', retry_count: 5, last_error: 'node unreachable', processed_at: expect.any(Date) });
    expect((await nftRow(nftId)).status).toBe('FAILED');
    expect(chain.mint).toHaveBeenCalledTimes(2);
  });

  it('a stale job reclaimed by instance B is owned by B: A\'s late failure is a no-op and A skips batch jobs it no longer owns', async () => {
    const first = await parentJob('2 minutes');
    const second = await parentJob('1 minute');
    const gate = deferred<string>();
    const chainA = chainStub((tokenId) => (tokenId === first.nftId ? gate.promise : Promise.resolve('0xA')));
    const chainB = chainStub(async () => '0xB');
    const a = createWorker(chainA);
    const b = createWorker(chainB);

    // A claims both jobs and blocks inside the first mint; the second job sits claimed-but-unprocessed in A's batch
    const pollA = a.poll();
    await waitFor(() => chainA.mint.mock.calls.length === 1, 'instance A to start minting');

    // both of A's jobs look abandoned (started_at 16 minutes ago) → B's stale sweep requeues them and B claims + finishes them
    await db.query(`UPDATE nft_job SET started_at = now() - interval '16 minutes' WHERE id = ANY($1::uuid[])`, [[first.jobId, second.jobId]]);
    await b.poll();
    expect(chainB.mint.mock.calls.map(([tokenId]) => tokenId).sort()).toEqual([first.nftId, second.nftId].sort());
    expect(await jobRow(first.jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0 });
    expect(await jobRow(second.jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0 });

    // A wakes up: its mint of the first job fails late — the job is B's now, so no retry_count bump, no FAILED, nft untouched
    gate.reject(new Error('late timeout from A'));
    await pollA;
    expect(await jobRow(first.jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
    expect(await nftRow(first.nftId)).toEqual({ status: 'MINTED', token_id: first.nftId, mint_tx_hash: '0xB' });
    // and A never touched the second job because its per-job ownership re-stamp found 0 PROCESSING rows
    expect(chainA.mint).toHaveBeenCalledTimes(1);
    expect(await nftRow(second.nftId)).toEqual({ status: 'MINTED', token_id: second.nftId, mint_tx_hash: '0xB' });
  });
});
