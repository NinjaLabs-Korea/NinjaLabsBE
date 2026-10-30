import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { CLAIM_PENDING_JOBS_SQL, NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { AlertService } from '../common/alerts/alert.service';
import { NftJobsAdminService } from '../nfts/nft-jobs-admin.service';
import { AuditService } from '../audit/audit.service';
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
  afterAll(async () => db.onApplicationShutdown());

  function chainStub(mint: (tokenId: string) => Promise<string>, options: { configured?: boolean; tokenExists?: boolean } = {}) {
    return {
      isConfigured: () => options.configured ?? true,
      contractAddress: () => 'inj1testcontract',
      tokenExists: jest.fn(async () => options.tokenExists ?? false),
      mint: jest.fn(mint),
    };
  }

  function createWorker(chain: ReturnType<typeof chainStub>): NftJobWorker {
    // 운영 알림은 대역 — 호출만 기록한다 (worker['alerts'].notify)
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new NftJobWorker(db, chain as unknown as InjectiveNftClient, testConfig(), alerts as unknown as AlertService);
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

  async function nftChainColumns(id: string) {
    const r = await db.query<{ contract_address: string | null; minted_at: Date | null }>(
      `SELECT contract_address, minted_at FROM nft WHERE id = $1`, [id]);
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
    expect(worker['alerts'].notify).not.toHaveBeenCalled();

    await db.query(`UPDATE nft_job SET scheduled_at = now() WHERE id = $1`, [jobId]);
    await worker.poll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'FAILED', retry_count: 5, last_error: 'node unreachable', processed_at: expect.any(Date) });
    expect((await nftRow(nftId)).status).toBe('FAILED');
    expect(chain.mint).toHaveBeenCalledTimes(2);
    // FAILED에 도달한 순간 운영 알림 한 번 (잡 종류별 키)
    expect(worker['alerts'].notify).toHaveBeenCalledWith('nft-job-failed:MINT_PARENT', expect.stringContaining(`nft_job ${jobId} (MINT_PARENT, nft ${nftId}) reached FAILED`));
  });

  it('operator retry of a permanently FAILED mint: PENDING with retry_count 0, the nft back to PENDING, audited — and the next poll mints it', async () => {
    const { nftId, jobId } = await parentJob('1 minute');
    const failing = chainStub(async () => { throw new Error('node unreachable'); });
    await db.query(`UPDATE nft_job SET retry_count = 4 WHERE id = $1`, [jobId]);
    await createWorker(failing).poll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'FAILED', retry_count: 5 });
    expect((await nftRow(nftId)).status).toBe('FAILED');

    const admin = await createUser(db);
    const jobs = new NftJobsAdminService(db, new AuditService(db));
    const listed = await jobs.list({ status: 'FAILED', page: 1 });
    expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: jobId, nft_status: 'FAILED', last_error: 'node unreachable' })]));
    await expect(jobs.retry(jobId, admin)).resolves.toEqual({ id: jobId, nft_id: nftId, status: 'PENDING', retry_count: 0 });
    expect(await jobRow(jobId)).toMatchObject({ status: 'PENDING', retry_count: 0, processed_at: null, last_error: 'node unreachable' });
    expect((await nftRow(nftId)).status).toBe('PENDING');
    const audit = await db.query(`SELECT actor_user_id, action FROM audit_log WHERE entity_type = 'nft_job' AND entity_id = $1`, [jobId]);
    expect(audit.rows).toEqual([{ actor_user_id: admin, action: 'NFT_JOB_RETRIED' }]);
    await expect(jobs.retry(jobId, admin)).rejects.toThrow('NFT_JOB_NOT_FOUND_OR_NOT_FAILED');

    const healthy = chainStub(async () => '0xretried');
    await createWorker(healthy).poll();
    expect(await jobRow(jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
    expect(await nftRow(nftId)).toEqual({ status: 'MINTED', token_id: nftId, mint_tx_hash: '0xretried' });
  });

  it('operator retry of a FAILED attach restores the already-minted child to MINTED (no re-mint) so the attach can run', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const parent = (await nfts.enqueueParentMint(userId, wallet.id))!;
    await db.query(`UPDATE nft SET status = 'MINTED', minted_at = now() WHERE id = $1`, [parent.nftId]);
    await db.query(`UPDATE nft_job SET status = 'SUCCEEDED' WHERE nft_id = $1`, [parent.nftId]);
    const child = await childJob(userId, wallet.id);
    await db.query(`UPDATE nft_job SET status = 'SUCCEEDED' WHERE id = $1`, [child.jobId]);
    // the child was minted, then its attach exhausted its retries: the worker marks the nft FAILED
    await db.query(`UPDATE nft SET status = 'FAILED', minted_at = now(), token_id = id::text WHERE id = $1`, [child.nftId]);
    const attach = await db.query<{ id: string }>(
      `INSERT INTO nft_job (nft_id, job_type, idempotency_key, status, retry_count, last_error)
       VALUES ($1, 'ATTACH_CHILD', $2, 'FAILED', 5, 'attach failed') RETURNING id`, [child.nftId, `attach-child:${child.nftId}`]);

    await new NftJobsAdminService(db, new AuditService(db)).retry(attach.rows[0].id, userId);
    expect((await nftRow(child.nftId)).status).toBe('MINTED');

    const chain = chainStub(async () => '0xnever');
    await createWorker(chain).poll();
    expect(chain.mint).not.toHaveBeenCalled();
    expect((await nftRow(child.nftId)).status).toBe('ATTACHED');
    expect((await attachJob(child.nftId)).status).toBe('SUCCEEDED');
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
    // SKIP LOCKED does not promise either claimant a full batch: two truly concurrent scans interleave their row locks, so the 13 due
    // jobs can split 7/6 as well as 10/3. What it does promise is checked here and below: each batch ≤ LIMIT 10, disjoint, and together
    // every due job exactly once. (A `max === 10` assertion was flaky in CI — 2026-10-25.)
    expect(idsA.length).toBeLessThanOrEqual(10);
    expect(idsB.length).toBeLessThanOrEqual(10);
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
    expect(b['alerts'].notify).toHaveBeenCalledWith('nft-job-stale-requeue', expect.stringContaining('requeued 2 nft_job(s)'));
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
    expect(deferred).toMatchObject({ status: 'PENDING', retry_count: 0, last_error: 'parent NFT not minted yet - attach deferred', processed_at: null });
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
  it('an unconfigured chain defers the job by 1 hour with an explanatory last_error, burning no retry and leaving the nft PENDING (even on what would be the last attempt)', async () => {
    const { nftId, jobId } = await parentJob('1 minute');
    await db.query(`UPDATE nft_job SET retry_count = 4 WHERE id = $1`, [jobId]);
    const chain = chainStub(async () => '0xnever', { configured: false });
    const before = Date.now();
    await createWorker(chain).poll();

    const job = await jobRow(jobId);
    expect(job).toMatchObject({
      status: 'PENDING', retry_count: 4, processed_at: null,
      last_error: 'NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured',
    });
    expect(job.scheduled_at.getTime() - before).toBeGreaterThan(55 * 60_000);
    expect(chain.mint).not.toHaveBeenCalled();
    expect(chain.tokenExists).not.toHaveBeenCalled();
    expect((await nftRow(nftId)).status).toBe('PENDING');
  });

  it('a token already on chain (crashed run) is recovered as MINTED with token_id and contract_address but no mint_tx_hash, without minting again', async () => {
    const { nftId, jobId } = await parentJob('1 minute');
    const chain = chainStub(async () => '0xnever', { tokenExists: true });
    await createWorker(chain).poll();

    expect(chain.mint).not.toHaveBeenCalled();
    expect(await jobRow(jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
    expect(await nftRow(nftId)).toEqual({ status: 'MINTED', token_id: nftId, mint_tx_hash: null });
    expect(await nftChainColumns(nftId)).toEqual({ contract_address: 'inj1testcontract', minted_at: expect.any(Date) });
  });

  it('a mint that succeeds on chain stores the contract address and minted_at next to token_id and the tx hash', async () => {
    const { nftId } = await parentJob('1 minute');
    await createWorker(chainStub(async () => '0xfresh')).poll();
    expect(await nftRow(nftId)).toEqual({ status: 'MINTED', token_id: nftId, mint_tx_hash: '0xfresh' });
    expect(await nftChainColumns(nftId)).toEqual({ contract_address: 'inj1testcontract', minted_at: expect.any(Date) });
  });

  it('the stale sweep requeues only jobs PROCESSING for over 15 minutes and resets only their MINTING nfts; a fresh PROCESSING job and its nft are left alone', async () => {
    const stale = await parentJob('2 minutes');
    const fresh = await parentJob('1 minute');
    for (const { jobId, nftId } of [stale, fresh]) {
      await db.query(`UPDATE nft_job SET status = 'PROCESSING', started_at = now() WHERE id = $1`, [jobId]);
      await db.query(`UPDATE nft SET status = 'MINTING' WHERE id = $1`, [nftId]);
    }
    await db.query(`UPDATE nft_job SET started_at = now() - interval '16 minutes' WHERE id = $1`, [stale.jobId]);

    const worker = createWorker(chainStub(async () => '0xnever', { configured: false }));
    await worker.poll();

    // the stale job went back to PENDING, was reclaimed in the same poll and deferred (unconfigured chain), its MINTING nft reset
    expect(await jobRow(stale.jobId)).toMatchObject({ status: 'PENDING', retry_count: 0 });
    expect((await nftRow(stale.nftId)).status).toBe('PENDING');
    expect(await jobRow(fresh.jobId)).toMatchObject({ status: 'PROCESSING', retry_count: 0 });
    expect((await nftRow(fresh.nftId)).status).toBe('MINTING');
    expect(worker['alerts'].notify).toHaveBeenCalledWith('nft-job-stale-requeue', expect.stringContaining('requeued 1 nft_job(s)'));

    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE id = ANY($1::uuid[])`, [[stale.jobId, fresh.jobId]]);
  });

  it('a job that stopped being PROCESSING while its mint was in flight is not overwritten by a late success or a late permanent failure', async () => {
    const lateSuccess = await parentJob('2 minutes');
    const gateOk = deferred<string>();
    const okChain = chainStub(() => gateOk.promise);
    const okPoll = createWorker(okChain).poll();
    await waitFor(() => okChain.mint.mock.calls.length === 1, 'the mint to start');
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE id = $1`, [lateSuccess.jobId]);
    gateOk.resolve('0xlate');
    await okPoll;
    expect(await jobRow(lateSuccess.jobId)).toMatchObject({ status: 'CANCELLED', processed_at: null });

    // the nft itself did get minted on chain; only the job bookkeeping is fenced
    const lateFailure = await parentJob('2 minutes');
    await db.query(`UPDATE nft_job SET retry_count = 4 WHERE id = $1`, [lateFailure.jobId]);
    const gateFail = deferred<string>();
    const failChain = chainStub(() => gateFail.promise);
    const failWorker = createWorker(failChain);
    const failPoll = failWorker.poll();
    await waitFor(() => failChain.mint.mock.calls.length === 1, 'the second mint to start');
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE id = $1`, [lateFailure.jobId]);
    gateFail.reject(new Error('late 5th failure'));
    await failPoll;
    expect(await jobRow(lateFailure.jobId)).toMatchObject({ status: 'CANCELLED', retry_count: 4, last_error: null });
    expect((await nftRow(lateFailure.nftId)).status).not.toBe('FAILED');
    expect(failWorker['alerts'].notify).not.toHaveBeenCalled();
  });

  it('re-running the mint job of a child that is already MINTED does not mint again and leaves a single ATTACH_CHILD job (ON CONFLICT DO NOTHING)', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId: parentId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const chain = chainStub(async (tokenId) => `0x${tokenId.slice(0, 8)}`);
    const worker = createWorker(chain);
    await worker.poll();
    expect((await nftRow(parentId)).status).toBe('MINTED');
    const child = await childJob(userId, wallet.id);
    await worker.poll();
    const mintsBefore = chain.mint.mock.calls.length;
    expect((await attachJob(child.nftId)).status).toBe('PENDING');

    await db.query(`UPDATE nft_job SET status = 'PENDING', scheduled_at = now() WHERE id = $1`, [child.jobId]);
    await worker.poll();
    expect(chain.mint.mock.calls.length).toBe(mintsBefore);
    expect(await jobRow(child.jobId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
    const attachJobs = await db.query(`SELECT id FROM nft_job WHERE nft_id = $1 AND job_type = 'ATTACH_CHILD'`, [child.nftId]);
    expect(attachJobs.rows).toHaveLength(1);
  });
});
