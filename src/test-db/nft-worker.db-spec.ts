import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { CLAIM_PENDING_JOBS_SQL, NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, deferred, testConfig, unique, waitFor } from './harness';

// 실제 클라이언트는 @injectivelabs/sdk-ts(ESM)를 끌어오므로 DI 메타데이터용 껍데기로 대체한다 (유닛 스펙과 동일)
jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

type JobRow = { status: string; retry_count: number; last_error: string | null; scheduled_at: Date; processed_at: Date | null };

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

  /** 자식 NFT + MINT_CHILD 잡 (payout PAID 직후 상태) — 바운티/제출물 행은 chk_nft_child_refs 때문에 필요하다 */
  async function childJob(userId: string, walletId: string): Promise<{ nftId: string; jobId: string }> {
    const bountyId = (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days') RETURNING id`, [userId, unique('nft-flow-')])).rows[0].id;
    const submissionId = (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
       VALUES ($1, $2, 'https://example.test/w', 'd', 'APPROVED') RETURNING id`, [bountyId, userId])).rows[0].id;
    const { nftId } = (await nfts.enqueueChildMint(userId, walletId, bountyId, submissionId))!;
    const job = await db.query<{ id: string }>(`SELECT id FROM nft_job WHERE nft_id = $1 AND job_type = 'MINT_CHILD'`, [nftId]);
    return { nftId, jobId: job.rows[0].id };
  }

  async function attachJob(childId: string) {
    const r = await db.query<JobRow & { id: string }>(
      `SELECT id, status, retry_count, last_error, scheduled_at, processed_at FROM nft_job WHERE idempotency_key = $1`, [`attach-child:${childId}`]);
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

  it('two instances claiming inside two open transactions at the same time each get a disjoint, non-empty batch immediately (FOR UPDATE SKIP LOCKED)', async () => {
    // more due jobs than one LIMIT 10 batch, so the second claimant has something left to take
    const mine = await Promise.all(Array.from({ length: 13 }, (_, i) => parentJob(`${i + 1} minutes`)));
    const myIds = new Set(mine.map((job) => job.jobId));

    // both transactions run the worker's claim statement and then wait for each other BEFORE committing — while A still holds its
    // row locks, B must come back at once with the rows A skipped. Without SKIP LOCKED, B blocks on A's rows and the barrier times out.
    const bothClaimed = deferred<void>();
    let arrived = 0;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('second claim did not return while the first transaction held its rows — SKIP LOCKED is not in effect')), 5_000);
    });
    const claim = () => db.tx(async (client) => {
      const r = await client.query<{ id: string }>(CLAIM_PENDING_JOBS_SQL);
      if (++arrived === 2) bothClaimed.resolve();
      await Promise.race([bothClaimed.promise, timeout]);
      return r.rows.map((row) => row.id);
    });
    let idsA: string[];
    let idsB: string[];
    try {
      [idsA, idsB] = await Promise.all([claim(), claim()]);
    } finally {
      clearTimeout(timer);
    }

    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    expect(Math.max(idsA.length, idsB.length)).toBe(10); // one of them took a full LIMIT 10 batch
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]); // disjoint
    const claimed = new Set([...idsA, ...idsB]);
    for (const id of myIds) expect(claimed.has(id)).toBe(true); // between them, every due job was claimed exactly once
    const states = await db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM nft_job WHERE id = ANY($1::uuid[]) GROUP BY status`, [[...claimed]]);
    expect(states.rows).toEqual([{ status: 'PROCESSING', n: claimed.size }]);

    // nothing processes these — close them so later tests (and the 15-minute stale sweep) never see them
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE id = ANY($1::uuid[])`, [[...claimed]]);
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

  it('a child minted while its parent is still PENDING stays MINTED; the parent mint then queues ATTACH_CHILD and the next poll attaches it', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId: parentId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    // hold the parent mint back so the child is processed first (the payout flow does not wait for the parent)
    await db.query(`UPDATE nft_job SET scheduled_at = now() + interval '1 hour' WHERE nft_id = $1`, [parentId]);
    const child = await childJob(userId, wallet.id);
    expect((await db.query<{ parent_nft_id: string }>(`SELECT parent_nft_id FROM nft WHERE id = $1`, [child.nftId])).rows[0].parent_nft_id).toBe(parentId);
    const chain = chainStub(async (tokenId) => `0x${tokenId.slice(0, 8)}`);
    const worker = createWorker(chain);

    // 1) child mints, parent is PENDING → child MINTED, no ATTACH_CHILD yet
    await worker.poll();
    expect(chain.mint.mock.calls.map(([tokenId]) => tokenId)).toEqual([child.nftId]);
    expect(await jobRow(child.jobId)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await nftRow(child.nftId)).status).toBe('MINTED');
    expect((await nftRow(parentId)).status).toBe('PENDING');
    expect(await attachJob(child.nftId)).toBeUndefined();

    // 2) a legacy/early ATTACH_CHILD picked up before the parent is ready is deferred (+1h, PENDING, no retry consumed), child stays MINTED
    await db.query(`INSERT INTO nft_job (nft_id, job_type, idempotency_key) VALUES ($1, 'ATTACH_CHILD', $2)`, [child.nftId, `attach-child:${child.nftId}`]);
    const before = Date.now();
    await worker.poll();
    const deferred = await attachJob(child.nftId);
    expect(deferred).toMatchObject({ status: 'PENDING', retry_count: 0, last_error: 'parent NFT not minted yet — attach deferred', processed_at: null });
    expect(deferred.scheduled_at.getTime() - before).toBeGreaterThan(55 * 60_000);
    expect((await nftRow(child.nftId)).status).toBe('MINTED');

    // 3) the parent mints → ATTACH_CHILD for the waiting child is pulled forward (scheduled now) by the parent's children scan
    await db.query(`UPDATE nft_job SET scheduled_at = now() WHERE nft_id = $1`, [parentId]);
    await worker.poll();
    expect(await nftRow(parentId)).toEqual({ status: 'MINTED', token_id: parentId, mint_tx_hash: `0x${parentId.slice(0, 8)}` });
    const queued = await attachJob(child.nftId);
    expect(queued.status).toBe('PENDING');
    expect(queued.scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await nftRow(child.nftId)).status).toBe('MINTED');

    // 4) next poll attaches the child (DB-only transition), job SUCCEEDED
    await worker.poll();
    expect(await attachJob(child.nftId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
    expect((await nftRow(child.nftId)).status).toBe('ATTACHED');
    expect(chain.mint).toHaveBeenCalledTimes(2); // child + parent only — attach never touches the chain on path A
  });

  it('a child minted after its parent is already MINTED queues ATTACH_CHILD itself (no parent scan needed)', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId: parentId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const chain = chainStub(async (tokenId) => `0x${tokenId.slice(0, 8)}`);
    const worker = createWorker(chain);
    await worker.poll();
    expect((await nftRow(parentId)).status).toBe('MINTED');

    const child = await childJob(userId, wallet.id);
    await worker.poll();
    expect((await nftRow(child.nftId)).status).toBe('MINTED');
    expect(await attachJob(child.nftId)).toMatchObject({ status: 'PENDING', retry_count: 0 });
    await worker.poll();
    expect(await attachJob(child.nftId)).toMatchObject({ status: 'SUCCEEDED' });
    expect((await nftRow(child.nftId)).status).toBe('ATTACHED');
  });
});
