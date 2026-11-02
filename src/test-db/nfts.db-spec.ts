import { AlertService } from '../common/alerts/alert.service';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { sslOptions } from '../../scripts/migrate';
import { DatabaseService } from '../common/database/database.service';
import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { describeDb } from './describe-db';
import { createDb, createPrimaryWallet, createUser, testConfig, testSslEnv, TEST_DB_URL_ENV, unique } from './harness';

jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

/** 운영 알림 대역 - 호출만 기록한다 (nft-worker.db-spec와 같은 방식) */
const opsAlerts = () => ({ notify: jest.fn(async () => true) }) as unknown as AlertService;

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
  // the worker claims any due job - park whatever other tests left behind so each test sees only its own jobs
  beforeEach(async () => {
    await db.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PROCESSING')`);
  });
  afterAll(async () => db.onApplicationShutdown());

  function worker(chain: Partial<{ configured: boolean; exists: boolean }> = {}) {
    const stub = {
      isConfigured: () => chain.configured ?? true,
      contractAddress: () => 'inj1testcontract',
      tokenExists: jest.fn(async () => chain.exists ?? false),
      mint: jest.fn(async (tokenId: string) => `0x${tokenId.replace(/-/g, '').slice(0, 8)}`),
    };
    const w = new NftJobWorker(db, stub as unknown as InjectiveNftClient, testConfig(), opsAlerts());
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

  function expectedId(kind: string, businessId: string) {
    const bytes = createHash('sha1').update(Buffer.from('711f8f847cbf5107a96e3f3be23a82ab', 'hex'))
      .update(`NinjaLabs/nft/${kind}/v1/${businessId}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  it('uses business-key UUIDv5 for new parent/child issuance, independent of wallet and contract', async () => {
    const user = await createUser(db), wallet = await createPrimaryWallet(db, user), s = await submission(user);
    const parent = (await nfts.enqueueParentMint(user, wallet.id))!;
    const child = (await nfts.enqueueChildMint(user, wallet.id, s.bountyId, s.submissionId))!;
    expect(parent.nftId).toBe(expectedId('parent', user));
    expect(child.nftId).toBe(expectedId('child', s.submissionId));
    expect(parent.nftId).not.toBe(expectedId('child', user));
    await db.query(`DELETE FROM nft WHERE id=$1`, [child.nftId]);
    await db.query(`DELETE FROM nft WHERE id=$1`, [parent.nftId]);
    const otherWallet = (await db.query(`INSERT INTO wallet (user_id,address,is_primary,verified_at)
      VALUES ($1,$2,false,now()) RETURNING id`, [user, unique('inj1')])).rows[0].id;
    const restored = new NftsService(db, testConfig({ NFT_CONTRACT_ADDRESS: 'other-config-does-not-create-new-identity' }));
    expect((await restored.enqueueParentMint(user, otherWallet))!.nftId).toBe(parent.nftId);
    expect((await restored.enqueueChildMint(user, otherWallet, s.bountyId, s.submissionId))!.nftId).toBe(child.nftId);
  });

  it('recovers a rewound new parent row using the same simulated on-chain token instead of issuing twice', async () => {
    const user = await createUser(db), wallet = await createPrimaryWallet(db, user);
    const first = (await nfts.enqueueParentMint(user, wallet.id))!;
    const chainTokens = new Set<string>(), { w, stub } = worker();
    stub.tokenExists.mockImplementation(async (id?: string) => chainTokens.has(id!));
    stub.mint.mockImplementation(async (id: string) => { if (chainTokens.has(id)) throw Error('duplicate token'); chainTokens.add(id); return '0xtx'; });
    await w.poll();
    expect(chainTokens.size).toBe(1);
    // Simulated own-row rewind only, in this throwaway database. Chain set survives.
    await db.query(`DELETE FROM nft WHERE id=$1`, [first.nftId]);
    const restored = (await nfts.enqueueParentMint(user, wallet.id))!;
    expect(restored.nftId).toBe(first.nftId);
    await w.poll();
    expect(stub.mint).toHaveBeenCalledTimes(1);
    expect(await nftRow(restored.nftId)).toMatchObject({ status: 'MINTED', token_id: first.nftId });
    expect((await jobOf(restored.nftId)).status).toBe('SUCCEEDED');
  });

  it('does not rewrite old random IDs or explicit reconciliation IDs when the new migration is applied', async () => {
    const schema = `nft_upgrade_${randomUUID().replaceAll('-', '')}`, oldId = randomUUID(), explicitId = randomUUID(), user = randomUUID();
    const migration = readFileSync(join(__dirname, '../../supabase/migrations/0027_stable_nft_issuance.sql'), 'utf8');
    await db.tx(async (tx) => {
      await tx.query(`CREATE SCHEMA "${schema}"`);
      await tx.query(`SET LOCAL search_path TO "${schema}", public, pg_catalog`);
      await tx.query(`CREATE TABLE nft (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid, submission_id uuid, nft_type text, token_id text)`);
      await tx.query(`INSERT INTO nft(id,owner_user_id,nft_type,token_id) VALUES ($1,$2,'NINJA_PARENT','old-token')`, [oldId, user]);
      const before = (await tx.query(`SELECT * FROM nft`)).rows;
      await tx.query(migration);
      expect((await tx.query(`SELECT * FROM nft`)).rows).toEqual(before);
      expect((await tx.query(`INSERT INTO nft(id,owner_user_id,nft_type) VALUES ($1,$2,'NINJA_PARENT') RETURNING id`, [explicitId, randomUUID()])).rows[0].id).toBe(explicitId);
      expect((await tx.query(`INSERT INTO nft(owner_user_id,nft_type) VALUES ($1,'NINJA_PARENT') RETURNING id`, [user])).rows[0].id).toBe(expectedId('parent', user));
      await tx.query(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });

  it('supports Supabase-style pgcrypto in a non-public extensions schema without changing the app search_path', async () => {
    const base = new URL(process.env[TEST_DB_URL_ENV]!);
    if (!/^\/ninjalabs_test_[a-z0-9_]+$/.test(base.pathname)) throw Error('isolated test DB required');
    const name = `ninjalabs_test_crypto_${randomUUID().replaceAll('-', '')}`;
    const ssl = sslOptions(testSslEnv());
    const admin = new Pool({ connectionString: base.toString(), ssl, max: 1 });
    let scratch: Pool | undefined, created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`); created = true;
      base.pathname = `/${name}`;
      scratch = new Pool({ connectionString: base.toString(), ssl, max: 1 });
      await scratch.query(`CREATE SCHEMA extensions`);
      await scratch.query(`CREATE EXTENSION pgcrypto WITH SCHEMA extensions`);
      await scratch.query(`CREATE TABLE nft (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_user_id uuid, submission_id uuid, nft_type text)`);
      await scratch.query(readFileSync(join(__dirname, '../../supabase/migrations/0027_stable_nft_issuance.sql'), 'utf8'));
      const user = randomUUID();
      const row = await scratch.query(`INSERT INTO nft(owner_user_id,nft_type) VALUES ($1,'NINJA_PARENT') RETURNING id`, [user]);
      expect(row.rows[0].id).toBe(expectedId('parent', user));
      expect((await scratch.query(`SHOW search_path`)).rows[0].search_path).not.toContain('extensions');
    } finally {
      await scratch?.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  });

  it.each(['false', 'TRUE', '1', 'tru'])('does no DB/chain work when minting flag explicitly pauses with %s', async (value) => {
    const { w, stub } = worker();
    const config = jest.spyOn(w['config'], 'get').mockReturnValue(value);
    const query = jest.spyOn(db, 'query'), tx = jest.spyOn(db, 'tx');
    try {
      await w.poll();
      expect(query).not.toHaveBeenCalled(); expect(tx).not.toHaveBeenCalled();
      expect(stub.tokenExists).not.toHaveBeenCalled(); expect(stub.mint).not.toHaveBeenCalled();
    } finally { query.mockRestore(); tx.mockRestore(); config.mockRestore(); }
  });

  it.each([undefined, '', 'true'])('preserves parent and completion-child automatic issuance with minting flag %s', async (value) => {
    const user = await createUser(db), wallet = await createPrimaryWallet(db, user), s = await submission(user);
    const parent = (await nfts.enqueueParentMint(user, wallet.id))!;
    const child = (await nfts.enqueueChildMint(user, wallet.id, s.bountyId, s.submissionId))!;
    const { w, stub } = worker(), original = w['config'].get.bind(w['config']);
    jest.spyOn(w['config'], 'get').mockImplementation((key: string) => key === 'NFT_MINTING_ENABLED' ? value : original(key));
    await w.poll(); await w.poll();
    expect(stub.mint).toHaveBeenCalledTimes(2);
    for (const id of [parent.nftId, child.nftId]) expect(stub.mint).toHaveBeenCalledWith(id, wallet.address, null);
    expect((await nftRow(parent.nftId)).status).toBe('MINTED');
    expect((await nftRow(child.nftId)).status).toBe('ATTACHED');
  });

  it('rechecks pause after a slow lookup and releases its own job without spending retries', async () => {
    const user = await createUser(db), wallet = await createPrimaryWallet(db, user), { nftId } = (await nfts.enqueueParentMint(user, wallet.id))!;
    const { w, stub } = worker(); let enabled = true;
    jest.spyOn(w['config'], 'get').mockImplementation((key: string) => key === 'NFT_MINTING_ENABLED' ? String(enabled) : undefined);
    stub.tokenExists.mockImplementationOnce(async () => { enabled = false; return false; });
    await w.poll();
    expect(stub.mint).not.toHaveBeenCalled();
    expect(await jobOf(nftId)).toMatchObject({ status: 'PENDING', retry_count: 0 });
    expect(await nftRow(nftId)).toMatchObject({ status: 'PENDING' });
    enabled = true; await w.poll();
    expect(stub.mint).toHaveBeenCalledTimes(1);
    expect((await jobOf(nftId)).status).toBe('SUCCEEDED');
  });

  it('records an already-broadcast mint even if operators pause before its response returns', async () => {
    const user = await createUser(db), wallet = await createPrimaryWallet(db, user), { nftId } = (await nfts.enqueueParentMint(user, wallet.id))!;
    const { w, stub } = worker(); let enabled = true;
    jest.spyOn(w['config'], 'get').mockImplementation((key: string) => key === 'NFT_MINTING_ENABLED' ? String(enabled) : undefined);
    stub.mint.mockImplementationOnce(async () => { enabled = false; return '0xtx'; });
    await w.poll(); await w.poll();
    expect(stub.mint).toHaveBeenCalledTimes(1);
    expect(await jobOf(nftId)).toMatchObject({ status: 'SUCCEEDED', retry_count: 0 });
    expect(await nftRow(nftId)).toMatchObject({ status: 'MINTED', mint_tx_hash: '0xtx' });
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
    const w = new NftJobWorker(db, stub as unknown as InjectiveNftClient, testConfig({ MASTER_WALLET_MNEMONIC: mnemonic }), opsAlerts());
    await w.poll();
    const job = await jobOf(nftId);
    expect(job).toMatchObject({ status: 'PENDING', retry_count: 1 });
    expect(job.last_error).toBe('signing with "[redacted]" key=[redacted] failed');
  });
});
