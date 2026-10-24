import { DatabaseService } from '../common/database/database.service';
import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, testConfig, unique } from './harness';

jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

/**
 * NftsService enqueue idempotency (partial unique indexes uq_nft_parent_per_user / uq_nft_child_per_submission / uq_nft_job_idempotency)
 * and the worker paths that only make sense on real rows: orphan requeue, on-chain recovery, unconfigured defer.
 */
describeDb('nft enqueue and worker recovery on a real database', () => {
  let db: DatabaseService;
  let nfts: NftsService;

  beforeAll(() => {
    db = createDb();
    nfts = new NftsService(db, testConfig());
  });
  // the worker claims any due job — park whatever other tests left behind so each test sees only its own jobs
  beforeEach(async () => {
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PROCESSING')`);
  });
  afterAll(async () => db.onModuleDestroy());

  function worker(chain: Partial<{ configured: boolean; exists: boolean }> = {}) {
    const stub = {
      isConfigured: () => chain.configured ?? true,
      contractAddress: () => 'inj1testcontract',
      tokenExists: jest.fn(async () => chain.exists ?? false),
      mint: jest.fn(async (tokenId: string) => `0x${tokenId.replace(/-/g, '').slice(0, 8)}`),
    };
    const w = new NftJobWorker(db, stub as unknown as InjectiveNftClient, testConfig());
    jest.spyOn(w['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(w['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(w['logger'], 'log').mockImplementation(() => undefined);
    return { w, stub };
  }

  async function submission(userId: string) {
    const bountyId = (await db.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline)
       VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days') RETURNING id`, [userId, unique('nfts-db-')])).rows[0].id;
    const submissionId = (await db.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
       VALUES ($1, $2, 'https://example.test/w', 'd', 'APPROVED') RETURNING id`, [bountyId, userId])).rows[0].id;
    return { bountyId, submissionId };
  }

  const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(sql, params)).rows[0].n;
  const nftRow = async (id: string) => (await db.query<{ status: string; token_id: string | null; mint_tx_hash: string | null; contract_address: string; minted_at: Date | null }>(
    `SELECT status, token_id, mint_tx_hash, contract_address, minted_at FROM nft WHERE id = $1`, [id])).rows[0];
  const jobOf = async (nftId: string) => (await db.query<{ id: string; status: string; retry_count: number; last_error: string | null; scheduled_at: Date }>(
    `SELECT id, status, retry_count, last_error, scheduled_at FROM nft_job WHERE nft_id = $1 ORDER BY created_at LIMIT 1`, [nftId])).rows[0];

  it('enqueueParentMint is idempotent per user: the second call returns null and leaves exactly one parent and one MINT_PARENT job', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const first = await nfts.enqueueParentMint(userId, wallet.id);
    expect(first).toEqual({ nftId: expect.any(String) });
    await expect(nfts.enqueueParentMint(userId, wallet.id)).resolves.toBeNull();

    expect(await count(`SELECT count(*)::int AS n FROM nft WHERE owner_user_id = $1 AND nft_type = 'NINJA_PARENT'`, [userId])).toBe(1);
    const jobs = await db.query<{ job_type: string; idempotency_key: string; status: string }>(
      `SELECT job_type, idempotency_key, status FROM nft_job WHERE nft_id = $1`, [first!.nftId]);
    expect(jobs.rows).toEqual([{ job_type: 'MINT_PARENT', idempotency_key: `mint-parent:${userId}`, status: 'PENDING' }]);
    expect((await nftRow(first!.nftId))).toMatchObject({ status: 'PENDING', contract_address: 'inj1testcontract', token_id: null });
  });

  it('enqueueChildMint links to the parent, is idempotent per submission, and a second submission gets its own child', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId: parentId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const s1 = await submission(userId);
    const child = await nfts.enqueueChildMint(userId, wallet.id, s1.bountyId, s1.submissionId);
    expect(child).toEqual({ nftId: expect.any(String), parentId });
    await expect(nfts.enqueueChildMint(userId, wallet.id, s1.bountyId, s1.submissionId)).resolves.toBeNull();
    expect(await count(`SELECT count(*)::int AS n FROM nft WHERE submission_id = $1`, [s1.submissionId])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM nft_job WHERE idempotency_key = $1`, [`mint-child:${s1.submissionId}`])).toBe(1);

    const s2 = await submission(userId);
    const other = await nfts.enqueueChildMint(userId, wallet.id, s2.bountyId, s2.submissionId);
    expect(other!.nftId).not.toBe(child!.nftId);
    expect((await nfts.listByUser(userId)).map((row: { id: string }) => row.id)).toEqual([parentId, child!.nftId, other!.nftId]);
  });

  it('a child enqueued before the user has a parent NFT is stored with no parent link', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const s = await submission(userId);
    const child = await nfts.enqueueChildMint(userId, wallet.id, s.bountyId, s.submissionId);
    expect(child).toEqual({ nftId: expect.any(String), parentId: null });
    const row = await db.query<{ parent_nft_id: string | null }>(`SELECT parent_nft_id FROM nft WHERE id = $1`, [child!.nftId]);
    expect(row.rows[0].parent_nft_id).toBeNull();
  });

  it('an orphaned PROCESSING job (>15 min) is requeued, its MINTING nft reset, and the same poll then mints it; a fresh PROCESSING job is left alone', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    await db.query(`UPDATE nft_job SET status = 'PROCESSING', started_at = now() - interval '16 minutes' WHERE nft_id = $1`, [nftId]);
    await db.query(`UPDATE nft SET status = 'MINTING' WHERE id = $1`, [nftId]);

    const otherUser = await createUser(db);
    const otherWallet = await createPrimaryWallet(db, otherUser);
    const { nftId: busyId } = (await nfts.enqueueParentMint(otherUser, otherWallet.id))!;
    await db.query(`UPDATE nft_job SET status = 'PROCESSING', started_at = now() - interval '5 minutes' WHERE nft_id = $1`, [busyId]);
    await db.query(`UPDATE nft SET status = 'MINTING' WHERE id = $1`, [busyId]);

    const { w, stub } = worker();
    await w.poll();

    expect(stub.mint.mock.calls.map(([tokenId]) => tokenId)).toEqual([nftId]);
    expect(await nftRow(nftId)).toMatchObject({ status: 'MINTED', token_id: nftId });
    expect((await jobOf(nftId)).status).toBe('SUCCEEDED');
    // the in-flight job of another instance is untouched
    expect((await jobOf(busyId)).status).toBe('PROCESSING');
    expect((await nftRow(busyId)).status).toBe('MINTING');
  });

  it('a token already on chain (crash after broadcast) is recovered as MINTED with token/contract set, mint_tx_hash left NULL, no re-mint', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const { w, stub } = worker({ exists: true });
    await w.poll();
    expect(stub.mint).not.toHaveBeenCalled();
    expect(await nftRow(nftId)).toMatchObject({ status: 'MINTED', token_id: nftId, contract_address: 'inj1testcontract', mint_tx_hash: null, minted_at: expect.any(Date) });
    expect((await jobOf(nftId))).toMatchObject({ status: 'SUCCEEDED', retry_count: 0, last_error: null });
  });

  it('a duplicate MINT job for an already MINTED nft succeeds without touching the chain or the stored tx hash', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const { w, stub } = worker();
    await w.poll();
    const minted = await nftRow(nftId);
    expect(minted.status).toBe('MINTED');

    await db.query(`INSERT INTO nft_job (nft_id, job_type, idempotency_key) VALUES ($1, 'RETRY_MINT', $2)`, [nftId, unique('retry-')]);
    await w.poll();
    expect(stub.tokenExists).toHaveBeenCalledTimes(1);
    expect(stub.mint).toHaveBeenCalledTimes(1);
    expect(await nftRow(nftId)).toEqual(minted);
    expect(await count(`SELECT count(*)::int AS n FROM nft_job WHERE nft_id = $1 AND status = 'SUCCEEDED'`, [nftId])).toBe(2);
  });

  it('with the chain unconfigured the job is pushed back an hour with a last_error and no retry consumed; the nft stays PENDING', async () => {
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const before = Date.now();
    const { w, stub } = worker({ configured: false });
    await w.poll();
    const job = await jobOf(nftId);
    expect(job).toMatchObject({ status: 'PENDING', retry_count: 0, last_error: 'NFT_CONTRACT_ADDRESS / MASTER_WALLET_MNEMONIC not configured' });
    expect(job.scheduled_at.getTime() - before).toBeGreaterThan(59 * 60_000);
    expect(stub.tokenExists).not.toHaveBeenCalled();
    expect((await nftRow(nftId)).status).toBe('PENDING');
  });

  it('a stored last_error never carries the master mnemonic or a 64-hex key', async () => {
    const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const userId = await createUser(db);
    const wallet = await createPrimaryWallet(db, userId);
    const { nftId } = (await nfts.enqueueParentMint(userId, wallet.id))!;
    const stub = {
      isConfigured: () => true,
      contractAddress: () => 'inj1testcontract',
      tokenExists: async () => false,
      mint: async () => { throw new Error(`signing with "${mnemonic}" key=0x${'ab'.repeat(32)} failed`); },
    };
    const w = new NftJobWorker(db, stub as unknown as InjectiveNftClient, testConfig({ MASTER_WALLET_MNEMONIC: mnemonic }));
    await w.poll();
    const job = await jobOf(nftId);
    expect(job).toMatchObject({ status: 'PENDING', retry_count: 1 });
    expect(job.last_error).toBe('signing with "[redacted]" key=[redacted] failed');
  });
});
