import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { MIGRATIONS_DIR, applyMigrations, migrationFiles, sslOptions } from '../../scripts/migrate';
import { SchemaGuard } from '../common/database/schema-guard';
import { describeDb } from './describe-db';
import { createDb, testSslEnv, unique } from './harness';

const HARDENING = '0014_security_hardening.sql';

/**
 * 0014의 입금 tx 해시 유니크 인덱스는 중복이 남아 있으면 마이그레이션을 **실패**시켜야 한다 (조용히 건너뛰지 않음) — 그리고 운영자가 정리한 뒤
 * 재실행하면 적용되어야 한다. payout 해시는 멀티시그 한 tx로 여러 수상자에게 보내는 경우가 정당하므로 중복이 있어도 막지 않고 정규화만 한다.
 * 공유 테스트 DB는 이미 전부 적용돼 있으므로 0001~0013만 적용한 별도 데이터베이스를 만들어 검증한다.
 * 같은 "0014 미적용" DB로 SchemaGuard의 MIGRATIONS_PENDING 거부도 확인한다.
 */
describeDb('0014 tx-hash uniqueness and SchemaGuard against a database stuck before 0014', () => {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const ssl = sslOptions(testSslEnv());
  const dbName = `ninjalabs_test_mig_${Date.now().toString(36)}_${unique().slice(0, 6)}`;
  let pool: Pool;
  let partialDir: string;
  let partialUrl: string;
  let bountyId: string;
  let submissionId: string;
  let rewardIds: string[];

  const migrationNames = async () => (await pool.query<{ name: string }>(`SELECT name FROM _migrations ORDER BY name`)).rows.map((row) => row.name);
  const indexNames = async () => (await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE indexname IN ('uq_bounty_reward_deposit_tx', 'uq_payout_tx') ORDER BY indexname`)).rows.map((row) => row.indexname);

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`CREATE DATABASE "${dbName}"`); } finally { await admin.end(); }
    const url = new URL(adminUrl);
    url.pathname = `/${dbName}`;
    partialUrl = url.toString();
    pool = new Pool({ connectionString: partialUrl, ssl, max: 2 });

    // 0014 직전까지만 담은 디렉터리 — 운영 러너와 같은 applyMigrations()로 적용한다
    partialDir = mkdtempSync(join(tmpdir(), 'ninjalabs-mig-'));
    for (const file of migrationFiles()) if (file < HARDENING) copyFileSync(join(MIGRATIONS_DIR, file), join(partialDir, file));
    const { applied } = await applyMigrations(pool, { dir: partialDir });
    expect(applied).not.toContain(HARDENING);

    // 같은 해시를 두 보상에 적은 레거시 데이터 (대소문자 변형 → 0014의 정규화 UPDATE 뒤 충돌해야 한다)
    // + 같은 payout 해시를 두 payout에 적은 레거시 데이터 (멀티 송금 — 0014는 이를 막지 않고 정규화만 해야 한다)
    const id = unique();
    const userId = (await pool.query<{ id: string }>(
      `INSERT INTO "user" (google_id, email, nickname, bio, onboarding_step) VALUES ($1, $2, $3, '', 2) RETURNING id`,
      [`google-${id}`, `${id}@example.test`, `user_${id.slice(0, 8)}`])).rows[0].id;
    // legacy cover image saved before the strict URL rule — 0014 must only *report* it (RAISE NOTICE), never fail on it
    bountyId = (await pool.query<{ id: string }>(
      `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, cover_image_url)
       VALUES ($1, 's', 't', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', '/uploads/legacy-cover.png') RETURNING id`, [userId])).rows[0].id;
    const depositHash = `0x${'ab'.repeat(32)}`;
    rewardIds = [];
    for (const hash of [depositHash, depositHash.toUpperCase().replace('0X', '0x')]) {
      rewardIds.push((await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address, deposit_tx_hash)
         VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 'inj1custody', $2) RETURNING id`, [bountyId, hash])).rows[0].id);
    }
    const walletId = (await pool.query<{ id: string }>(
      `INSERT INTO wallet (user_id, address, verified_at) VALUES ($1, $2, now()) RETURNING id`, [userId, `inj1${id}`])).rows[0].id;
    submissionId = (await pool.query<{ id: string }>(
      `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
       VALUES ($1, $2, 'https://example.test', 'd', 'APPROVED') RETURNING id`, [bountyId, userId])).rows[0].id;
    const payoutHash = `0x${'CD'.repeat(32)}`;
    for (const rewardId of rewardIds) {
      await pool.query(
        `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, payout_tx_hash)
         VALUES ($1, $2, $3, 1000, 'PAID', $4, $5, $6)`, [rewardId, submissionId, walletId, unique('idem-'), userId, payoutHash]);
    }
  });

  afterAll(async () => {
    await pool?.end();
    if (partialDir) rmSync(partialDir, { recursive: true, force: true });
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  it('refuses to start the app on that schema with MIGRATIONS_PENDING naming 0014, and boots on the fully migrated one', async () => {
    const stale = createDb({ DATABASE_URL: partialUrl });
    const current = createDb();
    try {
      const guard = new SchemaGuard(stale);
      jest.spyOn(guard['logger'], 'log').mockImplementation(() => undefined);
      await expect(guard.onModuleInit()).rejects.toThrow(`MIGRATIONS_PENDING: run npm run migrate (missing: ${HARDENING})`);
      const ok = new SchemaGuard(current);
      jest.spyOn(ok['logger'], 'log').mockImplementation(() => undefined);
      await expect(ok.onModuleInit()).resolves.toBeUndefined();
    } finally {
      await Promise.all([stale.onModuleDestroy(), current.onModuleDestroy()]);
    }
  });

  it('fails 0014 loudly while duplicate deposit tx hashes exist: rolled back, no _migrations row, no unique index', async () => {
    const notices: string[] = [];
    await expect(applyMigrations(pool, { log: (line) => notices.push(line) })).rejects.toMatchObject({
      file: HARDENING,
      code: '23505',
      message: expect.stringContaining('0014: cannot create uq_bounty_reward_deposit_tx — 1 duplicate bounty_reward.deposit_tx_hash value(s)'),
    });
    await expect(applyMigrations(pool)).rejects.toMatchObject({
      message: expect.stringMatching(/First 1: 0x(ab){32} \(x2\)\. Inspect with: SELECT deposit_tx_hash, count\(\*\), array_agg\(id\) FROM bounty_reward/),
    });
    expect(await migrationNames()).not.toContain(HARDENING);
    expect(await indexNames()).toEqual([]);
    // the normalization UPDATE ran inside the failed transaction, so the mixed-case legacy value is still there (idempotent re-run normalizes again)
    const hashes = await pool.query<{ deposit_tx_hash: string }>(`SELECT deposit_tx_hash FROM bounty_reward WHERE bounty_id = $1 ORDER BY deposit_tx_hash`, [bountyId]);
    expect(hashes.rows.map((row) => row.deposit_tx_hash)).toEqual([`0x${'AB'.repeat(32)}`, `0x${'ab'.repeat(32)}`]);
  });

  it('after the operator removes the deposit duplicates the migration applies; duplicate payout hashes (multi-send) survive, normalized, with no unique index', async () => {
    await pool.query(`UPDATE bounty_reward SET deposit_tx_hash = NULL WHERE id = $1`, [rewardIds[1]]);
    const log: string[] = [];
    const { applied } = await applyMigrations(pool, { log: (line) => log.push(line) });
    expect(applied).toEqual([HARDENING]);
    // the legacy cover image is reported, not rejected
    expect(log).toContainEqual(expect.stringContaining('[notice] 0014: bounty.cover_image_url — 1 row(s) would fail the strict create-DTO URL rule'));
    expect(log.some((line) => line.includes('notice.thumbnail_url'))).toBe(false);
    expect(await migrationNames()).toContain(HARDENING);
    expect(await indexNames()).toEqual(['uq_bounty_reward_deposit_tx']);
    const normalized = await pool.query<{ deposit_tx_hash: string | null }>(`SELECT deposit_tx_hash FROM bounty_reward WHERE id = $1`, [rewardIds[0]]);
    expect(normalized.rows[0].deposit_tx_hash).toBe(`0x${'ab'.repeat(32)}`);
    const payoutHashes = await pool.query<{ payout_tx_hash: string }>(`SELECT payout_tx_hash FROM payout WHERE submission_id = $1`, [submissionId]);
    expect(payoutHashes.rows.map((row) => row.payout_tx_hash)).toEqual([`0x${'cd'.repeat(32)}`, `0x${'cd'.repeat(32)}`]);
    // idempotent: a second run skips it
    await expect(applyMigrations(pool)).resolves.toMatchObject({ applied: [] });
    const stale = createDb({ DATABASE_URL: partialUrl });
    try {
      const guard = new SchemaGuard(stale);
      jest.spyOn(guard['logger'], 'log').mockImplementation(() => undefined);
      await expect(guard.onModuleInit()).resolves.toBeUndefined();
    } finally {
      await stale.onModuleDestroy();
    }
  });
});
