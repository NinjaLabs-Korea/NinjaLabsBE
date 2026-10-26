import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { promisify } from 'util';
import { run as grantAdmin } from '../../scripts/grant-admin';
import { applyMigrations, sslOptions } from '../../scripts/migrate';
import { run as forfeitAward } from '../../scripts/forfeit-award';
import { inspectReward, run as recordRefund } from '../../scripts/record-refund';
import { run as requeueNftJobs } from '../../scripts/requeue-nft-jobs';
import { AuditService } from '../audit/audit.service';
import { BountyAdminService } from '../bounties/admin/bounty-admin.service';
import { BountyLifecycleService } from '../bounties/admin/bounty-lifecycle.service';
import { RewardTokenResolver } from '../bounties/admin/reward-token.resolver';
import { DatabaseService } from '../common/database/database.service';
import { AlertService } from '../common/alerts/alert.service';
import { InjectiveNftClient } from '../nfts/injective-nft.client';
import { STATIC_FILE_EXTENSIONS } from '../users/nickname';
import { NftJobWorker } from '../nfts/nft-job.worker';
import { NftsService } from '../nfts/nfts.service';
import { payoutStatusSql } from '../rewards/payout-status';
import { RewardsService } from '../rewards/rewards.service';
import { describeDb } from './describe-db';
import { createDb, testConfig, testSslEnv, unique } from './harness';

// 실제 클라이언트는 @injectivelabs/sdk-ts(ESM)를 끌어오므로 DI 메타데이터용 껍데기로 대체한다 (nft-worker 스펙과 동일)
jest.mock('../nfts/injective-nft.client', () => ({ InjectiveNftClient: class {} }));

const SCRIPTS = join(__dirname, '..', '..', 'scripts');
const exec = promisify(execFile);

/**
 * 운영 스크립트(scripts/grant-admin.js, scripts/requeue-nft-jobs.js, scripts/mainnet-preflight.sql) — docs/runbook.md.
 * "마지막 운영자"와 `--all`은 데이터베이스 전체를 보므로 공유 테스트 DB가 아니라 이 파일 전용 데이터베이스를 새로 만든다 (migrate-lock 스펙과 같은 방식).
 */
describeDb('ops scripts on a real database', () => {
  const adminUrl = process.env.TEST_DATABASE_URL!;
  const ssl = sslOptions(testSslEnv());
  const name = `ninjalabs_test_ops_${Date.now().toString(36)}_${unique().slice(0, 6)}`;
  let url: string;
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`CREATE DATABASE "${name}"`); } finally { await admin.end(); }
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${name}`;
    url = parsed.toString();
    pool = new Pool({ connectionString: url, ssl, max: 2 });
    await applyMigrations(pool);
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new Pool({ connectionString: adminUrl, ssl, max: 1 });
    try { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await admin.end(); }
  });

  /** run()을 로그 수집과 함께 — prompt 기본값은 "no" (확인 없이 쓰지 않음을 검증) */
  async function invoke(
    script: typeof grantAdmin,
    argv: string[],
    prompt: (q: string) => Promise<boolean> = async () => false,
  ): Promise<{ code: number; out: string; prompts: string[] }> {
    const lines: string[] = [];
    const prompts: string[] = [];
    const code = await script(argv, {
      pool,
      log: (line) => lines.push(line),
      prompt: async (q) => { prompts.push(q); return prompt(q); },
    });
    return { code, out: lines.join('\n'), prompts };
  }

  async function createUser(options: { email?: string; isAdmin?: boolean; status?: string } = {}) {
    const id = unique();
    const email = options.email ?? `${id}@example.test`;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO "user" (google_id, email, nickname, onboarding_step, is_admin, status)
       VALUES ($1, $2, $3, 2, $4, $5) RETURNING id`,
      [`google-${id}`, email, `ops_${id.slice(0, 8)}`, options.isAdmin ?? false, options.status ?? 'ACTIVE'],
    );
    return { id: r.rows[0].id, email };
  }

  const isAdmin = async (userId: string) =>
    (await pool.query<{ is_admin: boolean }>(`SELECT is_admin FROM "user" WHERE id = $1`, [userId])).rows[0].is_admin;

  const auditRows = async (entityType: string, entityId: string) =>
    (await pool.query<{ action: string; actor_user_id: string | null; before_data: unknown; after_data: unknown }>(
      `SELECT action, actor_user_id, before_data, after_data FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at`,
      [entityType, entityId],
    )).rows;

  describe('scripts/grant-admin.js', () => {
    it('--dry-run prints the plan and writes nothing', async () => {
      const user = await createUser();
      const res = await invoke(grantAdmin, ['grant', user.email, '--dry-run']);
      expect(res.code).toBe(0);
      expect(res.out).toContain('is_admin false -> true');
      expect(res.out).toContain('dry-run  nothing written');
      expect(res.prompts).toEqual([]);
      expect(await isAdmin(user.id)).toBe(false);
      expect(await auditRows('user', user.id)).toEqual([]);
    });

    it('asks for confirmation and writes nothing when the answer is not "yes"', async () => {
      const user = await createUser();
      const res = await invoke(grantAdmin, ['grant', user.email]);
      expect(res.code).toBe(1);
      expect(res.prompts).toEqual([`Grant admin for ${user.email}?`]);
      expect(await isAdmin(user.id)).toBe(false);
      expect(await auditRows('user', user.id)).toEqual([]);
    });

    it('grants after confirmation (email matched case-insensitively) with an ADMIN_GRANTED audit row whose actor is NULL', async () => {
      const user = await createUser({ email: `${unique('Ops.')}@Example.test` });
      const res = await invoke(grantAdmin, ['grant', user.email.toUpperCase()], async () => true);
      expect(res.code).toBe(0);
      expect(await isAdmin(user.id)).toBe(true);
      expect(await auditRows('user', user.id)).toEqual([{
        action: 'ADMIN_GRANTED',
        actor_user_id: null,
        before_data: { is_admin: false },
        after_data: { is_admin: true, source: 'scripts/grant-admin.js' },
      }]);
    });

    it('is a no-op (no audit row) when the user already has the requested state', async () => {
      const user = await createUser({ isAdmin: true });
      const res = await invoke(grantAdmin, ['grant', user.email, '--yes']);
      expect(res.code).toBe(0);
      expect(res.out).toContain('no change');
      expect(await auditRows('user', user.id)).toEqual([]);
    });

    it('revokes with --yes and records ADMIN_REVOKED', async () => {
      await createUser({ isAdmin: true }); // someone else stays admin
      const user = await createUser({ isAdmin: true });
      const res = await invoke(grantAdmin, ['revoke', user.email, '--yes']);
      expect(res.code).toBe(0);
      expect(res.prompts).toEqual([]);
      expect(await isAdmin(user.id)).toBe(false);
      expect((await auditRows('user', user.id)).map((row) => row.action)).toEqual(['ADMIN_REVOKED']);
    });

    it('refuses to revoke the last active admin unless --force', async () => {
      await pool.query(`UPDATE "user" SET is_admin = false`);
      const user = await createUser({ isAdmin: true });
      await createUser({ isAdmin: true, status: 'SUSPENDED' }); // a suspended admin does not count

      // the preview already reports it, and an interactive run refuses before asking
      const preview = await invoke(grantAdmin, ['revoke', user.email, '--dry-run']);
      expect(preview.code).toBe(1);
      expect(preview.out).toContain('LAST_ADMIN');
      expect(preview.out).not.toContain('dry-run  nothing written');
      const interactive = await invoke(grantAdmin, ['revoke', user.email], async () => true);
      expect(interactive.code).toBe(1);
      expect(interactive.prompts).toEqual([]);

      const refused = await invoke(grantAdmin, ['revoke', user.email, '--yes']);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('LAST_ADMIN');
      expect(await isAdmin(user.id)).toBe(true);
      expect(await auditRows('user', user.id)).toEqual([]);

      const forced = await invoke(grantAdmin, ['revoke', user.email, '--yes', '--force']);
      expect(forced.code).toBe(0);
      expect(await isAdmin(user.id)).toBe(false);
    });

    it('rejects unknown emails, withdrawn users, typoed flags and bad usage without writing', async () => {
      expect((await invoke(grantAdmin, ['grant', 'nobody@example.test', '--yes'])).out).toContain('USER_NOT_FOUND');
      const withdrawn = await createUser();
      await pool.query(`UPDATE "user" SET deleted_at = now(), status = 'WITHDRAWN' WHERE id = $1`, [withdrawn.id]);
      const gone = await invoke(grantAdmin, ['grant', withdrawn.email, '--yes']);
      expect(gone.code).toBe(1);
      expect(gone.out).toContain('USER_NOT_FOUND');
      expect(await isAdmin(withdrawn.id)).toBe(false);

      const user = await createUser();
      expect((await invoke(grantAdmin, ['grant', user.email, '--dry-rn'])).code).toBe(2);
      expect((await invoke(grantAdmin, ['promote', user.email])).code).toBe(2);
      expect((await invoke(grantAdmin, ['grant'])).code).toBe(2);
      expect(await isAdmin(user.id)).toBe(false);
    });

    it('runs as a real CLI with the migrate.js connection settings (DATABASE_URL + PGSSLMODE) and refuses without a TTY unless --yes', async () => {
      const user = await createUser();
      const env = { ...process.env, DATABASE_URL: url, PGSSLMODE: testSslEnv().PGSSLMODE, DATABASE_CA_CERT: testSslEnv().DATABASE_CA_CERT ?? '' };
      const script = join(SCRIPTS, 'grant-admin.js');

      const noTty = await exec('node', [script, 'grant', user.email], { env }).catch((err) => err);
      expect(noTty.code).toBe(1);
      expect(noTty.stdout).toContain('aborted');
      expect(await isAdmin(user.id)).toBe(false);

      const ok = await exec('node', [script, 'grant', user.email, '--yes'], { env });
      expect(ok.stdout).toContain(`done     ${user.email} is_admin=true`);
      expect(await isAdmin(user.id)).toBe(true);
    });
  });

  describe('scripts/requeue-nft-jobs.js', () => {
    /** 5회 실패해 FAILED로 고정된 잡 — mintedTokenId가 있으면 민팅은 끝나고 attach가 실패한 자식 */
    async function failedJob(jobType = 'MINT_PARENT', mintedTokenId?: string) {
      const user = await createUser();
      const wallet = await pool.query<{ id: string }>(
        `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
        [user.id, `inj1${unique()}`],
      );
      const nft = await pool.query<{ id: string }>(
        `INSERT INTO nft (owner_user_id, owner_wallet_id, nft_type, contract_address, status, token_id)
         VALUES ($1, $2, 'NINJA_PARENT', 'inj1testcontract', 'FAILED', $3) RETURNING id`,
        [user.id, wallet.rows[0].id, mintedTokenId ?? null],
      );
      const job = await pool.query<{ id: string }>(
        `INSERT INTO nft_job (nft_id, job_type, idempotency_key, status, retry_count, last_error, processed_at)
         VALUES ($1, $2, $3, 'FAILED', 5, 'rpc timeout', now()) RETURNING id`,
        [nft.rows[0].id, jobType, unique('ops-')],
      );
      return { nftId: nft.rows[0].id, jobId: job.rows[0].id };
    }

    const jobRow = async (id: string) => (await pool.query<{
      status: string; retry_count: number; last_error: string | null; processed_at: Date | null; due: boolean;
    }>(`SELECT status, retry_count, last_error, processed_at, scheduled_at <= now() AS due FROM nft_job WHERE id = $1`, [id])).rows[0];
    const nftStatus = async (id: string) =>
      (await pool.query<{ status: string }>(`SELECT status FROM nft WHERE id = $1`, [id])).rows[0].status;

    it('--dry-run lists the FAILED job and writes nothing', async () => {
      const { jobId, nftId } = await failedJob();
      const res = await invoke(requeueNftJobs, [jobId, '--dry-run']);
      expect(res.code).toBe(0);
      expect(res.out).toContain(`job      ${jobId}  MINT_PARENT`);
      expect(res.out).toContain('last_error=rpc timeout');
      expect((await jobRow(jobId)).status).toBe('FAILED');
      expect(await nftStatus(nftId)).toBe('FAILED');
    });

    it('requeues one job by id after confirmation: PENDING, fresh retry budget, nft back to PENDING, NFT_JOB_REQUEUED audit', async () => {
      const { jobId, nftId } = await failedJob();
      const other = await failedJob();
      const res = await invoke(requeueNftJobs, [jobId.toUpperCase()], async () => true);
      expect(res.code).toBe(0);
      expect(res.prompts).toEqual(['Requeue 1 nft_job(s)?']);
      expect(await jobRow(jobId)).toMatchObject({ status: 'PENDING', retry_count: 0, last_error: 'rpc timeout', processed_at: null, due: true });
      expect(await nftStatus(nftId)).toBe('PENDING');
      expect(await auditRows('nft_job', jobId)).toEqual([{
        action: 'NFT_JOB_REQUEUED', actor_user_id: null, before_data: null, after_data: { source: 'scripts/requeue-nft-jobs.js' },
      }]);
      expect((await jobRow(other.jobId)).status).toBe('FAILED'); // untouched
    });

    it('puts an already-minted NFT (failed attach) back to MINTED so the attach branch can run again', async () => {
      const { jobId, nftId } = await failedJob('ATTACH_CHILD', 'token-1');
      expect((await invoke(requeueNftJobs, [jobId, '--yes'])).code).toBe(0);
      expect(await nftStatus(nftId)).toBe('MINTED');
    });

    it('--all requeues every FAILED job and skips non-FAILED ids by name', async () => {
      const a = await failedJob();
      const b = await failedJob();
      const res = await invoke(requeueNftJobs, ['--all', '--yes']);
      expect(res.code).toBe(0);
      expect((await jobRow(a.jobId)).status).toBe('PENDING');
      expect((await jobRow(b.jobId)).status).toBe('PENDING');
      expect((await pool.query(`SELECT 1 FROM nft_job WHERE status = 'FAILED'`)).rowCount).toBe(0);

      const again = await invoke(requeueNftJobs, [a.jobId, '--yes']);
      expect(again.code).toBe(1);
      expect(again.out).toContain(`skip     ${a.jobId} — not found or not FAILED`);
      expect((await invoke(requeueNftJobs, ['--all', '--yes'])).out).toContain('nothing to requeue');
    });

    it('a requeued job is picked up and finished by the real NftJobWorker (the reset retry budget is what lets it run)', async () => {
      await pool.query(`UPDATE nft_job SET status = 'CANCELLED' WHERE status IN ('PENDING', 'PROCESSING')`);
      const { jobId, nftId } = await failedJob();
      expect((await invoke(requeueNftJobs, [jobId, '--yes'])).code).toBe(0);

      const db = createDb({ DATABASE_URL: url });
      try {
        const chain = { isConfigured: () => true, contractAddress: () => 'inj1testcontract', tokenExists: jest.fn(async () => false), mint: jest.fn(async () => '0xabc') };
        const alerts = { notify: jest.fn(async () => true) }; // 운영 알림 대역 (nft-worker.db-spec와 같은 방식)
        const worker = new NftJobWorker(db, chain as unknown as InjectiveNftClient, testConfig({ DATABASE_URL: url }), alerts as unknown as AlertService);
        await worker.poll();
        expect(chain.mint).toHaveBeenCalledWith(nftId, expect.any(String), null);
        expect(await jobRow(jobId)).toMatchObject({ status: 'SUCCEEDED', last_error: null });
        expect(await nftStatus(nftId)).toBe('MINTED');
      } finally {
        await db.onApplicationShutdown();
      }
    });

    it('rejects bad usage: no target, ids together with --all, non-UUID ids, unknown flags', async () => {
      const { jobId } = await failedJob();
      expect((await invoke(requeueNftJobs, [])).code).toBe(2);
      expect((await invoke(requeueNftJobs, ['--all', jobId])).code).toBe(2);
      expect((await invoke(requeueNftJobs, ['not-a-uuid'])).code).toBe(2);
      expect((await invoke(requeueNftJobs, [jobId, '--force'])).code).toBe(2);
      expect((await invoke(requeueNftJobs, [jobId])).code).toBe(1); // prompt answered "no"
      expect((await jobRow(jobId)).status).toBe('FAILED');
    });
  });

  describe('scripts/mainnet-preflight.sql', () => {
    const file = readFileSync(join(SCRIPTS, 'mainnet-preflight.sql'), 'utf8');

    /** psql 메타 줄(`\...`)을 빼고 psql 변수를 리터럴로 바꾼 뒤, `;`로 끝나는 줄 단위로 문장을 나눈다 (파일 머리 주석의 규칙) */
    function statements(vars: Record<string, string>): string[] {
      const body = file
        .split('\n')
        .filter((line) => !line.startsWith('\\') && !line.trimStart().startsWith('--'))
        .join('\n')
        .replace(/:'(\w+)'/g, (_m, key: string) => `'${(vars[key] ?? '').replace(/'/g, "''")}'`);
      return body.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
    }

    async function runPreflight(vars: Record<string, string> = {}) {
      const client = await pool.connect();
      const results: Record<string, unknown>[][] = [];
      try {
        for (const sql of statements(vars)) results.push((await client.query(sql)).rows);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      return results.flat().reduce<Record<string, Record<string, unknown>[]>>((acc, row) => {
        const check = String(row.check);
        (acc[check] ??= []).push(row);
        return acc;
      }, {});
    }

    it('nickname uniqueness no longer depends on the database locale (0019): silent when the ICU collation exists and no two active nicknames fold together', async () => {
      const result = await runPreflight();
      expect(result.nickname_icu_collation_missing ?? []).toHaveLength(0);
      expect(result.nickname_fold_collision ?? []).toHaveLength(0);
      // the unique index folds with the same expression the preflight uses, so a C-locale database cannot hold CAFÉ next to café
      const collide = pool.query(
        `INSERT INTO "user" (google_id, email, nickname, bio) SELECT 'g-' || x, x || '@x.test', n, '' FROM (VALUES ('fold1', 'Café'), ('fold2', 'CAFÉ')) AS v(x, n)`);
      await expect(collide).rejects.toMatchObject({ code: '23505', constraint: 'uq_user_nickname_active' });
    });

    it('wraps everything in a READ ONLY transaction that ends in ROLLBACK, and contains no write statements', () => {
      const list = statements({});
      expect(list[0]).toBe('BEGIN TRANSACTION READ ONLY');
      expect(list[list.length - 1]).toBe('ROLLBACK');
      for (const sql of list.slice(1, -1)) expect(sql).toMatch(/^SELECT\b/);
    });

    it('flags the PENDING_MULTISIG_SETUP placeholder, a custody address that differs from the expected one and testnet ERC-20 without writing', async () => {
      const user = await createUser();
      const bounty = await pool.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline)
         VALUES ($1, 's', 'preflight', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days') RETURNING id`, [user.id]);
      const expected = `inj1${'q'.repeat(38)}`;
      const insertReward = async (custody: string, extra = `'NATIVE', 'inj', NULL, NULL`) => (await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, token_contract_address, evm_chain_id, display_symbol, amount, custody_address)
         VALUES ($1, ${extra}, 'X', 1, $2) RETURNING id`, [bounty.rows[0].id, custody])).rows[0].id;
      const placeholder = await insertReward('PENDING_MULTISIG_SETUP');
      const otherMultisig = await insertReward(`inj1${'p'.repeat(38)}`);
      const fine = await insertReward(expected);
      const testnetUsdc = await insertReward(expected, `'ERC20', 'erc20:x', '0x${'a'.repeat(40)}', 1439`);

      const before = await pool.query(`SELECT count(*)::int AS n FROM audit_log`);
      const checks = await runPreflight({ expected_custody: expected });
      const flagged = (checks.custody_placeholder ?? []).map((row) => row.reward_id);
      expect(flagged).toEqual(expect.arrayContaining([placeholder, otherMultisig]));
      expect(flagged).not.toContain(fine);
      expect((checks.erc20_testnet_chain ?? []).map((row) => row.reward_id)).toEqual([testnetUsdc]);
      expect(checks.last_migration).toHaveLength(1);
      expect(checks.platform_settings.length).toBeGreaterThan(0);

      // without an expected address only the placeholder / malformed shapes are flagged
      const loose = (await runPreflight()).custody_placeholder.map((row) => row.reward_id);
      expect(loose).toContain(placeholder);
      expect(loose).not.toContain(otherMultisig);
      expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n).toBe(before.rows[0].n);
    });

    it('accepts an EVM (0x) multisig custody address, compares it case-insensitively and still flags malformed ones', async () => {
      await pool.query(`UPDATE bounty_reward SET status = 'CANCELLED'`);
      const user = await createUser();
      const bounty = await pool.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline)
         VALUES ($1, 's', 'preflight-evm', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days') RETURNING id`, [user.id]);
      const safe = `0x${'Ab'.repeat(20)}`;
      const insertReward = async (custody: string) => (await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, custody_address)
         VALUES ($1, 'NATIVE', 'inj', 'X', 1, $2) RETURNING id`, [bounty.rows[0].id, custody])).rows[0].id;
      const evm = await insertReward(safe);
      const malformed = await insertReward('inj1tooshort');

      expect((await runPreflight()).custody_placeholder.map((row) => row.reward_id)).toEqual([malformed]);
      expect((await runPreflight({ expected_custody: safe.toLowerCase() })).custody_placeholder.map((row) => row.reward_id))
        .toEqual([malformed]);
      expect((await runPreflight({ expected_custody: `inj1${'q'.repeat(38)}` })).custody_placeholder.map((row) => row.reward_id))
        .toEqual(expect.arrayContaining([evm, malformed]));
    });
  });

  describe('scripts/find-static-ext-nicknames.sql', () => {
    const file = readFileSync(join(SCRIPTS, 'find-static-ext-nicknames.sql'), 'utf8');
    const statements = file
      .split('\n')
      .filter((line) => !line.startsWith('\\') && !line.trimStart().startsWith('--'))
      .join('\n')
      .split(/;\s*\n/).map((sql) => sql.trim()).filter(Boolean);

    it('is a single SELECT inside a READ ONLY transaction, with exactly the STATIC_FILE_EXTENSIONS list', () => {
      expect(statements).toHaveLength(3);
      expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
      expect(statements[1]).toMatch(/^SELECT\b/);
      expect(statements[2]).toBe('ROLLBACK');
      expect(statements[1]).toContain(`'\\.(${STATIC_FILE_EXTENSIONS.join('|')})$'`);
    });

    it('lists only ACTIVE, non-deleted users whose nickname ends in a static file extension (case-insensitive), without writing', async () => {
      const tag = unique().slice(0, 6);
      const insert = async (nickname: string, status = 'ACTIVE', deleted = false) => (await pool.query<{ id: string }>(
        `INSERT INTO "user" (google_id, email, nickname, onboarding_step, status, deleted_at)
         VALUES ($1, $2, $3, 2, $4, $5) RETURNING id`,
        [`google-${unique()}`, `${unique()}@example.test`, nickname, status, deleted ? new Date() : null])).rows[0].id;
      const png = await insert(`n${tag}.png`);
      const upper = await insert(`n${tag}.JSON`);
      await insert(`n${tag}.jsx`);
      await insert(`n${tag}_png`);
      await insert(`s${tag}.css`, 'SUSPENDED');
      await insert(`d${tag}.js`, 'WITHDRAWN', true);

      const client = await pool.connect();
      try {
        const rows: { id: string; nickname: string }[] = [];
        for (const sql of statements) rows.push(...(await client.query(sql)).rows);
        const mine = rows.filter((row) => row.nickname.includes(tag)).map((row) => row.id);
        expect(mine.sort()).toEqual([png, upper].sort());
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });

  /** docs/runbook.md §7.4 수동 SQL 블록을 그대로 돌린다 (payout SQL 스펙과 취소→환불 스펙이 같이 쓴다) */
  const runbook = readFileSync(join(__dirname, '..', '..', 'docs', 'runbook.md'), 'utf8');
  const sqlBlock = (marker: string) => {
    const block = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).find((body) => body.includes(marker));
    if (!block) throw new Error(`no sql block containing ${marker} in docs/runbook.md`);
    return block;
  };
  /** 자리표시값 치환 → `;`로 끝나는 줄 단위 문장 (주석 줄 제거) */
  const statements = (block: string, payoutId: string, newAmount = '1') => block
    .split('\n').map((line) => line.replace(/^\s+/, '')).filter((line) => line && !line.startsWith('--')).join('\n')
    .replace(/<payout id>/g, payoutId)
    .replace(/<정정 금액>(?=,)/, newAmount) // UPDATE의 숫자 자리 (JSON 안의 것은 아래에서 문자열로)
    .replace(/<[^>]+>/g, 'x')
    .split(/;\s*\n/).map((sql) => sql.trim().replace(/;$/, '')).filter(Boolean);

  async function runTemplate(marker: string, payoutId: string, newAmount?: string) {
    const client = await pool.connect();
    const results: { rowCount: number | null; rows: Record<string, unknown>[] }[] = [];
    try {
      for (const sql of statements(sqlBlock(marker), payoutId, newAmount)) results.push(await client.query(sql));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return results;
  }

  /**
   * docs/runbook.md §7.4의 수동 payout SQL 템플릿을 문서에서 그대로 꺼내 실 스키마에 돌린다 — 컬럼/상태 값/재계산이 코드와 어긋나면 여기서 깨진다.
   * (`POST /admin/payouts`는 같은 보상·제출물의 payout이 있으면 상태와 무관하게 409라 "취소 후 재요청"이 불가능하다는 것이 템플릿의 전제)
   */
  describe('docs/runbook.md manual payout SQL', () => {
    async function seedPayouts(maxWinners: number, statuses: string[]) {
      const admin = await createUser({ isAdmin: true });
      const bounty = await pool.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners)
         VALUES ($1, 's', 'payout-sql', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', $2) RETURNING id`, [admin.id, maxWinners]);
      const reward = await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
         VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 1000, $2, 'PARTIALLY_PAID') RETURNING id`, [bounty.rows[0].id, `inj1${'q'.repeat(38)}`]);
      const payouts: string[] = [];
      for (const status of statuses) {
        const winner = await createUser();
        const wallet = await pool.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
          [winner.id, `inj1${unique()}`]);
        const submission = await pool.query<{ id: string }>(
          `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
           VALUES ($1, $2, 'https://example.test/s', 'd', 'APPROVED') RETURNING id`, [bounty.rows[0].id, winner.id]);
        const payout = await pool.query<{ id: string }>(
          `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by, approved_by, approved_at)
           VALUES ($1, $2, $3, 400, $4, $5, $6, $7, $8) RETURNING id`,
          [reward.rows[0].id, submission.rows[0].id, wallet.rows[0].id, status, unique('payout-'), admin.id,
           status === 'APPROVED' ? admin.id : null, status === 'APPROVED' ? new Date() : null]);
        payouts.push(payout.rows[0].id);
      }
      return { rewardId: reward.rows[0].id, payouts };
    }

    it('PAYOUT_CORRECTED_MANUAL corrects the amount in place, resets approval and records the audit row in one transaction', async () => {
      const { payouts: [payoutId] } = await seedPayouts(2, ['APPROVED', 'PAID']);
      const results = await runTemplate('PAYOUT_CORRECTED_MANUAL', payoutId, '350');
      // BEGIN, cap check, UPDATE, INSERT, COMMIT
      expect(results[1].rows[0]).toMatchObject({ status: 'APPROVED', current_amount: '400', cap: '1000', others: '400' });
      expect(results[2].rowCount).toBe(1);
      const row = (await pool.query(`SELECT amount::text, status, approved_by, approved_at FROM payout WHERE id = $1`, [payoutId])).rows[0];
      expect(row).toEqual({ amount: '350', status: 'REQUESTED', approved_by: null, approved_at: null });
      expect((await auditRows('payout', payoutId)).map((r) => [r.action, r.actor_user_id])).toEqual([['PAYOUT_CORRECTED_MANUAL', null]]);
    });

    it('PAYOUT_CORRECTED_MANUAL does not touch a payout that is already PAID', async () => {
      const { payouts: [payoutId] } = await seedPayouts(1, ['PAID']);
      const results = await runTemplate('PAYOUT_CORRECTED_MANUAL', payoutId, '350');
      expect(results[2].rowCount).toBe(0); // the runbook says: UPDATE 0 → ROLLBACK
      expect((await pool.query(`SELECT amount::text FROM payout WHERE id = $1`, [payoutId])).rows[0].amount).toBe('400');
    });

    it('PAYOUT_CANCELLED_MANUAL cancels, audits and recomputes the reward to PAID when the remaining winners are paid', async () => {
      const { rewardId, payouts: [open] } = await seedPayouts(2, ['REQUESTED', 'PAID', 'PAID']);
      await runTemplate('PAYOUT_CANCELLED_MANUAL', open);
      expect((await pool.query(`SELECT status FROM payout WHERE id = $1`, [open])).rows[0].status).toBe('CANCELLED');
      expect((await pool.query(`SELECT status FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].status).toBe('PAID');
      expect((await auditRows('payout', open)).map((r) => r.action)).toEqual(['PAYOUT_CANCELLED_MANUAL']);
    });

    it('PAYOUT_CANCELLED_MANUAL leaves the reward PARTIALLY_PAID while winners remain', async () => {
      const { rewardId, payouts: [open] } = await seedPayouts(3, ['AWAITING_MULTISIG_APPROVAL', 'PAID']);
      await runTemplate('PAYOUT_CANCELLED_MANUAL', open);
      expect((await pool.query(`SELECT status FROM bounty_reward WHERE id = $1`, [rewardId])).rows[0].status).toBe('PARTIALLY_PAID');
    });
  });

  describe('scripts/record-refund.js', () => {
    let counter = 0;
    let opsDb: DatabaseService;
    let opsBounties: BountyAdminService;
    beforeAll(() => {
      // the real BountyAdminService on this file's private database (url is set by the outer beforeAll)
      const config = testConfig({ DATABASE_URL: url });
      opsDb = new DatabaseService(config);
      opsBounties = new BountyAdminService(opsDb, new AuditService(opsDb), new BountyLifecycleService(), new RewardTokenResolver(config));
    });
    afterAll(async () => opsDb.onApplicationShutdown());
    /** 테스트마다 다른 64자리 hex — 같은 DB 안에서 환불 증빙 해시는 재사용할 수 없다 */
    const freshTx = () => `0x${(++counter).toString(16).padStart(64, 'a')}`;

    async function seedRefund(options: { bounty?: string; reward?: string; payouts?: string[]; deposited?: number } = {}) {
      const admin = await createUser({ isAdmin: true });
      const bounty = await pool.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
         VALUES ($1, 's', 'refund', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', 3, $2) RETURNING id`, [admin.id, options.bounty ?? 'CANCELLED']);
      const reward = await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
         VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, $2, $3, $4) RETURNING id`,
        [bounty.rows[0].id, options.deposited ?? 1000, `inj1${'q'.repeat(38)}`, options.reward ?? 'FUNDED']);
      for (const status of options.payouts ?? []) {
        const winner = await createUser();
        const wallet = await pool.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
          [winner.id, `inj1${unique()}`]);
        const submission = await pool.query<{ id: string }>(
          `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
           VALUES ($1, $2, 'https://example.test/s', 'd', 'APPROVED') RETURNING id`, [bounty.rows[0].id, winner.id]);
        await pool.query(
          `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by)
           VALUES ($1, $2, $3, 300, $4, $5, $6)`,
          [reward.rows[0].id, submission.rows[0].id, wallet.rows[0].id, status, unique('refund-'), admin.id]);
      }
      return { bountyId: bounty.rows[0].id, rewardId: reward.rows[0].id, adminId: admin.id };
    }

    const rewardStatus = async (id: string) =>
      (await pool.query<{ status: string }>(`SELECT status FROM bounty_reward WHERE id = $1`, [id])).rows[0].status;

    it('records the refund: REFUNDED + REWARD_REFUNDED audit (actor NULL, deposited minus PAID), then bounty delete is allowed', async () => {
      const TX = freshTx();
      const { bountyId, rewardId, adminId } = await seedRefund({ reward: 'PARTIALLY_PAID', payouts: ['PAID', 'CANCELLED', 'FAILED'] });
      await expect(opsBounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      const res = await invoke(recordRefund, [rewardId, '--tx', TX.slice(2).toUpperCase()], async () => true);
      expect(res.code).toBe(0);
      expect(res.prompts).toHaveLength(1);
      expect(await rewardStatus(rewardId)).toBe('REFUNDED');
      expect(await auditRows('bounty_reward', rewardId)).toEqual([{
        action: 'REWARD_REFUNDED',
        actor_user_id: null,
        before_data: { status: 'PARTIALLY_PAID' },
        after_data: { txHash: TX, refundedAmount: '700', source: 'scripts/record-refund.js' },
      }]);
      // the real delete guard: refused before the script, allowed after
      await expect(opsBounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
    });

    it('accepts a PAID reward with deposit left (deposited − PAID > 0): refunds the remainder, then the delete guard lets the bounty go', async () => {
      const { bountyId, rewardId, adminId } = await seedRefund({ reward: 'PAID', deposited: 1500, payouts: ['PAID', 'CANCELLED'] });
      await expect(opsBounties.remove(bountyId, adminId)).rejects.toMatchObject({ message: 'BOUNTY_HAS_OPEN_FUNDS' });
      const TX = freshTx();
      const dry = await invoke(recordRefund, [rewardId, '--tx', TX, '--dry-run']);
      expect(dry.out).toContain('plan     reward PAID -> REFUNDED, refundedAmount=1200');
      const res = await invoke(recordRefund, [rewardId, '--tx', TX, '--yes']);
      expect(res.code).toBe(0);
      expect(await rewardStatus(rewardId)).toBe('REFUNDED');
      expect(await auditRows('bounty_reward', rewardId)).toEqual([{
        action: 'REWARD_REFUNDED', actor_user_id: null, before_data: { status: 'PAID' },
        after_data: { txHash: TX, refundedAmount: '1200', source: 'scripts/record-refund.js' },
      }]);
      await expect(opsBounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
    });

    it('accepts a REFUND_PENDING reward', async () => {
      const { rewardId } = await seedRefund({ reward: 'REFUND_PENDING' });
      const res = await invoke(recordRefund, [rewardId, '--tx', `0x${'cd'.repeat(32)}`, '--yes']);
      expect(res.code).toBe(0);
      expect(await rewardStatus(rewardId)).toBe('REFUNDED');
    });

    it('--dry-run and a declined prompt change nothing', async () => {
      const TX = freshTx();
      const { rewardId } = await seedRefund();
      const dry = await invoke(recordRefund, [rewardId, '--tx', TX, '--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain('refundedAmount=1000');
      expect(dry.out).toContain('dry-run  nothing written');
      expect(dry.prompts).toEqual([]);
      const declined = await invoke(recordRefund, [rewardId, '--tx', TX]);
      expect(declined.code).toBe(1);
      expect(await rewardStatus(rewardId)).toBe('FUNDED');
      expect(await auditRows('bounty_reward', rewardId)).toEqual([]);
    });

    it.each([
      ['an OPEN bounty', { bounty: 'OPEN' }, 'not CANCELLED'],
      ['a COMPLETED bounty', { bounty: 'COMPLETED' }, 'not CANCELLED'],
      ['a fully paid PAID reward (deposit = PAID sum)', { reward: 'PAID', deposited: 300, payouts: ['PAID'] }, 'nothing to refund'],
      ['a PAID reward with an open payout', { reward: 'PAID', payouts: ['PAID', 'APPROVED'] }, 'still open'],
      ['a PAID reward on a COMPLETED bounty', { bounty: 'COMPLETED', reward: 'PAID', payouts: ['PAID'] }, 'not CANCELLED'],
      ['a DEPOSIT_PENDING reward', { reward: 'DEPOSIT_PENDING' }, 'expected one of'],
      ['an already REFUNDED reward', { reward: 'REFUNDED' }, 'expected one of'],
      ['an open payout (REQUESTED)', { payouts: ['PAID', 'REQUESTED'] }, 'still open'],
      ['an open payout (BROADCASTING)', { payouts: ['BROADCASTING'] }, 'still open'],
      ['everything already paid out', { reward: 'PARTIALLY_PAID', deposited: 300, payouts: ['PAID'] }, 'nothing to refund'],
    ])('refuses %s and writes nothing', async (_label, options, message) => {
      const TX = freshTx();
      const { rewardId } = await seedRefund(options);
      const before = await rewardStatus(rewardId);
      const res = await invoke(recordRefund, [rewardId, '--tx', TX, '--yes']);
      expect(res.code).toBe(1);
      expect(res.out).toContain(message);
      expect(await rewardStatus(rewardId)).toBe(before);
      expect(await auditRows('bounty_reward', rewardId)).toEqual([]);
    });

    it('refuses a missing reward, bad arguments and a tx hash already used as a deposit or payout', async () => {
      const TX = freshTx();
      expect((await invoke(recordRefund, [unique('x'), '--tx', TX])).code).toBe(2);
      expect((await invoke(recordRefund, ['00000000-0000-4000-8000-000000000000', '--tx', 'nope'])).code).toBe(2);
      expect((await invoke(recordRefund, ['00000000-0000-4000-8000-000000000000'])).code).toBe(2);
      expect((await invoke(recordRefund, ['00000000-0000-4000-8000-000000000000', '--tx', TX, '--nope'])).code).toBe(2);
      // the operator is told which argument is wrong, not only the usage line
      const ZERO = '00000000-0000-4000-8000-000000000000';
      expect((await invoke(recordRefund, [ZERO, '--tx', 'abc', '--dry-run'])).out).toContain('--tx must be a 32-byte hex transaction hash');
      expect((await invoke(recordRefund, [ZERO, '--dry-run'])).out).toContain('--tx <hash> is required');
      expect((await invoke(recordRefund, ['not-a-uuid', '--tx', TX])).out).toContain('<reward-id> must be a UUID');
      const missing = await invoke(recordRefund, ['00000000-0000-4000-8000-000000000000', '--tx', TX, '--yes']);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain('reward not found');

      const other = await seedRefund();
      const depositHash = `0x${'ee'.repeat(32)}`;
      await pool.query(`UPDATE bounty_reward SET deposit_tx_hash = $2 WHERE id = $1`, [other.rewardId, depositHash]);
      const { rewardId } = await seedRefund();
      const res = await invoke(recordRefund, [rewardId, '--tx', depositHash, '--yes']);
      expect(res.code).toBe(1);
      expect(res.out).toContain('already recorded as a deposit');
      expect(await rewardStatus(rewardId)).toBe('FUNDED');
    });

    it('refuses a tx hash already recorded as a payout or as an earlier refund', async () => {
      const paid = await seedRefund({ reward: 'PARTIALLY_PAID', payouts: ['PAID'] });
      const payoutHash = freshTx();
      await pool.query(`UPDATE payout SET payout_tx_hash = $2 WHERE bounty_reward_id = $1`, [paid.rewardId, payoutHash]);
      const a = await seedRefund();
      const asPayout = await invoke(recordRefund, [a.rewardId, '--tx', payoutHash, '--yes']);
      expect(asPayout.code).toBe(1);
      expect(asPayout.out).toContain('already recorded as a payout');

      const refundHash = freshTx();
      const first = await seedRefund();
      expect((await invoke(recordRefund, [first.rewardId, '--tx', refundHash, '--yes'])).code).toBe(0);
      const second = await invoke(recordRefund, [a.rewardId, '--tx', refundHash, '--yes']);
      expect(second.code).toBe(1);
      expect(second.out).toContain('already recorded as a refund');
      expect(await rewardStatus(a.rewardId)).toBe('FUNDED');
    });

    describe('cancel with an approved winner still owed (docs/decisions.md 2026-10-25)', () => {
      const OWED = 'Record completed payments for all approved winners and finish every pending payout.';

      /** IN_REVIEW bounty, funded 1000 reward, one approved winner — with a payout of `payout` status (or none) */
      async function seedOwed(payout: string | null) {
        const admin = await createUser({ isAdmin: true });
        const bounty = await pool.query<{ id: string }>(
          `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
           VALUES ($1, 's', 'cancel-owed', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', 3, 'IN_REVIEW') RETURNING id`, [admin.id]);
        const reward = await pool.query<{ id: string }>(
          `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
           VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 1000, $2, 'FUNDED') RETURNING id`, [bounty.rows[0].id, `inj1${'q'.repeat(38)}`]);
        const winner = await createUser();
        const wallet = await pool.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
          [winner.id, `inj1${unique()}`]);
        const submission = await pool.query<{ id: string }>(
          `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
           VALUES ($1, $2, 'https://example.test/s', 'd', 'APPROVED') RETURNING id`, [bounty.rows[0].id, winner.id]);
        let payoutId: string | null = null;
        if (payout) {
          payoutId = (await pool.query<{ id: string }>(
            `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by)
             VALUES ($1, $2, $3, 300, $4, $5, $6) RETURNING id`,
            [reward.rows[0].id, submission.rows[0].id, wallet.rows[0].id, payout, unique('owed-'), admin.id])).rows[0].id;
        }
        return { bountyId: bounty.rows[0].id, rewardId: reward.rows[0].id, adminId: admin.id, payoutId };
      }

      const bountyStatus = async (id: string) =>
        (await pool.query<{ status: string }>(`SELECT status FROM bounty WHERE id = $1`, [id])).rows[0].status;

      /** IN_REVIEW → OPEN (reopen) succeeds, then → CANCELLED is the 400 UNPAID_WINNERS body; the bounty stays OPEN with no BOUNTY_CANCELLED row */
      async function expectCancelBlocked(bountyId: string, adminId: string) {
        await expect(opsBounties.transition(bountyId, 'OPEN', adminId)).resolves.toEqual({ id: bountyId, status: 'OPEN' });
        const refused = opsBounties.transition(bountyId, 'CANCELLED', adminId);
        await expect(refused).rejects.toMatchObject({ status: 400, response: { statusCode: 400, error: 'Bad Request', message: [OWED] } });
        expect(await bountyStatus(bountyId)).toBe('OPEN');
        expect((await auditRows('bounty', bountyId)).map((r) => r.action)).toEqual(['BOUNTY_OPEN']);
        const lifecycle = await new BountyLifecycleService().blockers(opsDb, bountyId, { status: 'OPEN', submission_deadline: new Date(Date.now() + 86_400_000) });
        expect(lifecycle.blockerDetails.CANCELLED).toEqual([{ code: 'UNPAID_WINNERS' }]);
        expect(lifecycle.blockers.CANCELLED).toEqual([OWED]);
      }

      it('approved winner with no payout yet: reopen → CANCELLED = 400 UNPAID_WINNERS (the refund would have returned their share)', async () => {
        const { bountyId, adminId } = await seedOwed(null);
        await expectCancelBlocked(bountyId, adminId);
      });

      it.each(['REQUESTED', 'AWAITING_MULTISIG_APPROVAL', 'APPROVED', 'BROADCASTING'])('an open %s payout: reopen → CANCELLED = 400 UNPAID_WINNERS', async (status) => {
        const { bountyId, adminId } = await seedOwed(status);
        await expectCancelBlocked(bountyId, adminId);
      });

      it('after the winner is paid, CANCELLED succeeds and record-refund reports deposited − PAID', async () => {
        const { bountyId, rewardId, adminId, payoutId } = await seedOwed('APPROVED');
        await expectCancelBlocked(bountyId, adminId);
        // what markPaid leaves behind: PAID payout, reward PARTIALLY_PAID (3 winners allowed, 300 of 1000 paid)
        await pool.query(`UPDATE payout SET status = 'PAID', paid_at = now() WHERE id = $1`, [payoutId]);
        await pool.query(`UPDATE bounty_reward SET status = 'PARTIALLY_PAID' WHERE id = $1`, [rewardId]);
        await expect(opsBounties.transition(bountyId, 'CANCELLED', adminId)).resolves.toEqual({ id: bountyId, status: 'CANCELLED' });
        const { reward, refundedAmount } = await inspectReward(pool, rewardId);
        expect(reward).toMatchObject({ bounty_status: 'CANCELLED', reward_status: 'PARTIALLY_PAID', paid_total: '300', open_payouts: 0 });
        expect(refundedAmount).toBe('700');
        const res = await invoke(recordRefund, [rewardId, '--tx', freshTx(), '--yes']);
        expect(res.code).toBe(0);
        expect(res.out).toContain('refundedAmount=700');
      });

      it('after the award is cancelled per runbook §7.4 (PAYOUT_CANCELLED_MANUAL), CANCELLED succeeds and the whole deposit is refundable', async () => {
        const { bountyId, rewardId, adminId, payoutId } = await seedOwed('REQUESTED');
        await expectCancelBlocked(bountyId, adminId);
        await runTemplate('PAYOUT_CANCELLED_MANUAL', payoutId!);
        expect((await pool.query(`SELECT status FROM payout WHERE id = $1`, [payoutId])).rows[0].status).toBe('CANCELLED');
        await expect(opsBounties.transition(bountyId, 'CANCELLED', adminId)).resolves.toEqual({ id: bountyId, status: 'CANCELLED' });
        const { reward, refundedAmount } = await inspectReward(pool, rewardId);
        expect(reward).toMatchObject({ bounty_status: 'CANCELLED', reward_status: 'FUNDED', paid_total: '0', open_payouts: 0 });
        expect(refundedAmount).toBe('1000');
      });

      it.each(['DRAFT', 'FUNDING_PENDING', 'OPEN'])('a %s bounty without approved submissions still cancels', async (status) => {
        const admin = await createUser({ isAdmin: true });
        const bounty = await pool.query<{ id: string }>(
          `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
           VALUES ($1, 's', 'cancel-clean', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', 1, $2) RETURNING id`, [admin.id, status]);
        await pool.query(
          `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
           VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, $2, $3, $4)`,
          [bounty.rows[0].id, status === 'OPEN' ? 1000 : 0, `inj1${'q'.repeat(38)}`, status === 'OPEN' ? 'FUNDED' : 'DEPOSIT_PENDING']);
        if (status === 'OPEN') {
          // a submission still under review is not an owed winner
          const user = await createUser();
          await pool.query(
            `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status)
             VALUES ($1, $2, 'https://example.test/s', 'd', 'SUBMITTED')`, [bounty.rows[0].id, user.id]);
        }
        await expect(opsBounties.transition(bounty.rows[0].id, 'CANCELLED', admin.id)).resolves.toEqual({ id: bounty.rows[0].id, status: 'CANCELLED' });
        expect((await auditRows('bounty', bounty.rows[0].id)).map((r) => r.action)).toEqual(['BOUNTY_CANCELLED']);
      });

      // other routes to the same outcome (sponsor refunded a winner's share) — multi-reward, agent winners, wallet-less winners,
      // FAILED payouts, maxWinners raised after the reward closed, headroom freed by a runbook award cancel, SUBMISSION_CLOSED reopen
      async function seedBounty(maxWinners: number, rewards: Array<{ amount: number; status?: string; denom?: string }>) {
        const admin = await createUser({ isAdmin: true });
        const bounty = await pool.query<{ id: string }>(
          `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
           VALUES ($1, 's', 'cancel-probe', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', $2, 'IN_REVIEW') RETURNING id`, [admin.id, maxWinners]);
        const rewardIds: string[] = [];
        for (const rw of rewards) {
          rewardIds.push((await pool.query<{ id: string }>(
            `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
             VALUES ($1, 'NATIVE', $2, 'TKN', $3, $3, $4, $5) RETURNING id`,
            [bounty.rows[0].id, rw.denom ?? 'inj', rw.amount, `inj1${'q'.repeat(38)}`, rw.status ?? 'FUNDED'])).rows[0].id);
        }
        return { bountyId: bounty.rows[0].id, rewardIds, adminId: admin.id };
      }
      async function approvedWinner(bountyId: string, opts: { agent?: boolean; wallet?: boolean } = {}) {
        const owner = await createUser();
        let walletId: string | null = null;
        if (opts.wallet !== false) {
          walletId = (await pool.query<{ id: string }>(
            `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
            [owner.id, `inj1${unique()}`])).rows[0].id;
        }
        let agentId: string | null = null;
        if (opts.agent) {
          agentId = (await pool.query<{ id: string }>(
            `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status) VALUES ($1, 'a', $2, $3, 'ACTIVE') RETURNING id`,
            [owner.id, unique('pk-'), unique('aw-')])).rows[0].id;
        }
        const submissionId = (await pool.query<{ id: string }>(
          `INSERT INTO bounty_submission (bounty_id, submitter_user_id, agent_id, submission_url, description, status)
           VALUES ($1, $2, $3, 'https://example.test/s', 'd', 'APPROVED') RETURNING id`,
          [bountyId, agentId ? null : owner.id, agentId])).rows[0].id;
        return { ownerId: owner.id, walletId, agentId, submissionId };
      }
      async function payout(rewardId: string, w: { submissionId: string; walletId: string | null }, amount: number, status: string, adminId: string) {
        return (await pool.query<{ id: string }>(
          `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [rewardId, w.submissionId, w.walletId, amount, status, unique('probe-'), adminId])).rows[0].id;
      }

      it('multi-reward — paid on reward 1 but still owed on reward 2 blocks the cancel', async () => {
        const { bountyId, rewardIds: [r1], adminId } = await seedBounty(1, [{ amount: 1000 }, { amount: 500, denom: 'peggy0xusdt' }]);
        const w = await approvedWinner(bountyId);
        await payout(r1, w, 1000, 'PAID', adminId);
        await pool.query(`UPDATE bounty_reward SET status = 'PAID' WHERE id = $1`, [r1]);
        await expectCancelBlocked(bountyId, adminId);
      });

      it('agent-owned winner (agent REVOKED, owner active) with no payout blocks the cancel', async () => {
        const { bountyId, adminId } = await seedBounty(1, [{ amount: 1000 }]);
        const w = await approvedWinner(bountyId, { agent: true });
        await pool.query(`UPDATE agent SET status = 'REVOKED' WHERE id = $1`, [w.agentId]);
        await expectCancelBlocked(bountyId, adminId);
      });

      it('approved winner without a connected wallet still blocks the cancel (they can reconnect)', async () => {
        const { bountyId, adminId } = await seedBounty(1, [{ amount: 1000 }]);
        await approvedWinner(bountyId, { wallet: false });
        await expectCancelBlocked(bountyId, adminId);
      });

      it('FAILED payout blocks the cancel', async () => {
        const { bountyId, rewardIds: [r1], adminId } = await seedBounty(1, [{ amount: 1000 }]);
        const w = await approvedWinner(bountyId);
        await payout(r1, w, 1000, 'FAILED', adminId);
        await expectCancelBlocked(bountyId, adminId);
      });

      it('maxWinners raised after the reward closed PAID — the new winner with headroom blocks the cancel', async () => {
        const { bountyId, rewardIds: [r1], adminId } = await seedBounty(1, [{ amount: 1000 }]);
        const a = await approvedWinner(bountyId);
        await payout(r1, a, 400, 'PAID', adminId);
        await pool.query(`UPDATE bounty_reward SET status = 'PAID' WHERE id = $1`, [r1]);
        await opsBounties.update(bountyId, { maxWinners: 2 }, adminId);
        await approvedWinner(bountyId);
        await expect(opsBounties.transition(bountyId, 'OPEN', adminId)).resolves.toMatchObject({ status: 'OPEN' });
        await expect(opsBounties.transition(bountyId, 'CANCELLED', adminId)).rejects.toMatchObject({ status: 400, response: { message: [OWED] } });
      });

      it('pool fully allocated to A; A award cancelled per runbook frees headroom for unrequested B → cancel blocked', async () => {
        const { bountyId, rewardIds: [r1], adminId } = await seedBounty(2, [{ amount: 1000 }]);
        const a = await approvedWinner(bountyId);
        await approvedWinner(bountyId);
        const pa = await payout(r1, a, 1000, 'REQUESTED', adminId);
        await runTemplate('PAYOUT_CANCELLED_MANUAL', pa);
        await expectCancelBlocked(bountyId, adminId);
      });

      it('SUBMISSION_CLOSED → OPEN → CANCELLED is blocked too', async () => {
        const { bountyId, adminId } = await seedBounty(1, [{ amount: 1000 }]);
        await pool.query(`UPDATE bounty SET status = 'SUBMISSION_CLOSED' WHERE id = $1`, [bountyId]);
        await approvedWinner(bountyId);
        await expectCancelBlocked(bountyId, adminId);
      });
    });

    it('rolls the reward update back when the audit insert fails (same transaction)', async () => {
      const TX = freshTx();
      const { rewardId } = await seedRefund();
      await pool.query(`ALTER TABLE audit_log ADD CONSTRAINT tmp_refund_block CHECK (action <> 'REWARD_REFUNDED') NOT VALID`);
      try {
        await expect(invoke(recordRefund, [rewardId, '--tx', TX, '--yes'])).rejects.toThrow();
      } finally {
        await pool.query(`ALTER TABLE audit_log DROP CONSTRAINT tmp_refund_block`);
      }
      expect(await rewardStatus(rewardId)).toBe('FUNDED');
      expect(await auditRows('bounty_reward', rewardId)).toEqual([]);
    });
  });

  /**
   * scripts/forfeit-award.js — 지갑 없는 수상자(requestPayout 404)는 "받을 몫이 남은" 것으로 세져(다시 연결할 수 있으므로) COMPLETED·CANCELLED가
   * 둘 다 막힌다. 연락이 끊긴 경우 운영자가 이 스크립트로 수상을 몰수하면 바운티를 닫고, 취소 → 환불 → 삭제까지 갈 수 있다 (runbook §7.4).
   */
  describe('scripts/forfeit-award.js', () => {
    const OWED = 'Record completed payments for all approved winners and finish every pending payout.';
    let fDb: DatabaseService;
    let fBounties: BountyAdminService;
    let fRewards: RewardsService;
    let counter = 0;
    beforeAll(() => {
      const config = testConfig({ DATABASE_URL: url });
      fDb = new DatabaseService(config);
      fBounties = new BountyAdminService(fDb, new AuditService(fDb), new BountyLifecycleService(), new RewardTokenResolver(config));
      fRewards = new RewardsService(fDb, new NftsService(fDb, config), new AuditService(fDb), config);
    });
    afterAll(async () => fDb.onApplicationShutdown());
    const freshTx = () => `0x${(++counter).toString(16).padStart(64, 'b')}`;

    /** IN_REVIEW(기본) 바운티, 입금된 1000 보상, 지갑 없는 승인 수상자 하나(리비전 1 스냅샷 포함) */
    async function seedStuck(options: { bounty?: string; submission?: string; wallet?: boolean } = {}) {
      const admin = await createUser({ isAdmin: true });
      const bounty = await pool.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, max_winners, status)
         VALUES ($1, 's', 'forfeit', 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', 1, $2) RETURNING id`, [admin.id, options.bounty ?? 'IN_REVIEW']);
      const reward = await pool.query<{ id: string }>(
        `INSERT INTO bounty_reward (bounty_id, token_type, token_denom, display_symbol, amount, deposited_amount, custody_address, status)
         VALUES ($1, 'NATIVE', 'inj', 'INJ', 1000, 1000, $2, 'FUNDED') RETURNING id`, [bounty.rows[0].id, `inj1${'q'.repeat(38)}`]);
      const winner = await createUser();
      let walletId: string | null = null;
      if (options.wallet) {
        walletId = (await pool.query<{ id: string }>(
          `INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now()) RETURNING id`,
          [winner.id, `inj1${unique()}`])).rows[0].id;
      }
      const submissionId = (await pool.query<{ id: string }>(
        `INSERT INTO bounty_submission (bounty_id, submitter_user_id, submission_url, description, status, reviewed_at)
         VALUES ($1, $2, 'https://example.test/s', 'd', $3, now()) RETURNING id`,
        [bounty.rows[0].id, winner.id, options.submission ?? 'APPROVED'])).rows[0].id;
      const revisionId = (await pool.query<{ id: string }>(
        `INSERT INTO submission_revision (submission_id, revision_no, submission_url, description, created_by_user_id)
         VALUES ($1, 1, 'https://example.test/s', 'd', $2) RETURNING id`, [submissionId, winner.id])).rows[0].id;
      return { bountyId: bounty.rows[0].id, rewardId: reward.rows[0].id, adminId: admin.id, submissionId, revisionId, winnerId: winner.id, walletId };
    }

    const submissionStatus = async (id: string) =>
      (await pool.query<{ status: string }>(`SELECT status FROM bounty_submission WHERE id = $1`, [id])).rows[0].status;
    const reviews = async (submissionId: string) =>
      (await pool.query(`SELECT revision_id, reviewer_id, decision, comment FROM submission_review WHERE submission_id = $1 ORDER BY created_at`, [submissionId])).rows;
    const payoutStatusOf = async (submissionId: string) =>
      (await pool.query<{ status: string }>(
        `SELECT ${payoutStatusSql('s', 'b')} AS status FROM bounty_submission s JOIN bounty b ON b.id = s.bounty_id WHERE s.id = $1`, [submissionId])).rows[0].status;
    const forfeit = (submissionId: string, adminId: string, extra: string[] = ['--yes'], prompt?: (q: string) => Promise<boolean>) =>
      invoke(forfeitAward, [submissionId, '--reason', ' no wallet connected after 30 days ', '--admin', adminId, ...extra], prompt);

    it('no-wallet stuck state: COMPLETED and CANCELLED both blocked → forfeit → CANCELLED → record-refund → delete; payoutStatus NONE', async () => {
      const { bountyId, rewardId, adminId, submissionId, revisionId } = await seedStuck();
      // the stuck state: no payout can be requested, yet the winner counts as owed (they could reconnect)
      await expect(fRewards.requestPayout(rewardId, submissionId, '1000', adminId)).rejects.toMatchObject({ message: 'APPROVED_SUBMISSION_OR_WALLET_NOT_FOUND' });
      expect(await payoutStatusOf(submissionId)).toBe('PENDING');
      await expect(fBounties.transition(bountyId, 'COMPLETED', adminId)).rejects.toMatchObject({ status: 400, response: { message: [OWED] } });
      await expect(fBounties.transition(bountyId, 'OPEN', adminId)).resolves.toMatchObject({ status: 'OPEN' });
      await expect(fBounties.transition(bountyId, 'CANCELLED', adminId)).rejects.toMatchObject({ status: 400, response: { message: [OWED] } });

      // dry-run changes nothing
      const dry = await forfeit(submissionId, adminId, ['--dry-run']);
      expect(dry.code).toBe(0);
      expect(dry.out).toContain('plan     submission APPROVED -> REJECTED');
      expect(dry.out).toContain('"forfeited: no wallet connected after 30 days"');
      expect(dry.out).toContain('dry-run  nothing written');
      expect(dry.prompts).toEqual([]);
      expect(await submissionStatus(submissionId)).toBe('APPROVED');
      expect(await reviews(submissionId)).toEqual([]);
      expect(await auditRows('bounty_submission', submissionId)).toEqual([]);

      const res = await forfeit(submissionId, adminId.toUpperCase(), [], async () => true);
      expect(res.code).toBe(0);
      expect(res.prompts).toHaveLength(1);
      expect(await submissionStatus(submissionId)).toBe('REJECTED');
      expect(await reviews(submissionId)).toEqual([{ revision_id: revisionId, reviewer_id: adminId, decision: 'REJECT', comment: 'forfeited: no wallet connected after 30 days' }]);
      expect(await auditRows('bounty_submission', submissionId)).toEqual([{
        action: 'SUBMISSION_AWARD_FORFEITED',
        actor_user_id: adminId,
        before_data: { status: 'APPROVED' },
        after_data: { status: 'REJECTED', reason: 'no wallet connected after 30 days', bountyId, source: 'scripts/forfeit-award.js' },
      }]);

      // the bounty can close now: CANCELLED → refund of the whole deposit → delete
      await expect(fBounties.transition(bountyId, 'CANCELLED', adminId)).resolves.toEqual({ id: bountyId, status: 'CANCELLED' });
      const refund = await invoke(recordRefund, [rewardId, '--tx', freshTx(), '--yes']);
      expect(refund.code).toBe(0);
      expect(refund.out).toContain('refundedAmount=1000');
      await expect(fBounties.remove(bountyId, adminId)).resolves.toEqual({ id: bountyId });
      expect(await payoutStatusOf(submissionId)).toBe('NONE');
    });

    it('after a forfeit the IN_REVIEW bounty can complete as well (no owed winner left), and the maxWinners slot is free again', async () => {
      const { bountyId, adminId, submissionId } = await seedStuck();
      expect((await forfeit(submissionId, adminId)).code).toBe(0);
      const lifecycle = await new BountyLifecycleService().blockers(fDb, bountyId, { status: 'IN_REVIEW', submission_deadline: new Date(Date.now() + 86_400_000) });
      expect(lifecycle.blockerDetails.COMPLETED ?? []).not.toContainEqual({ code: 'UNPAID_WINNERS' });
      expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bounty_submission WHERE bounty_id = $1 AND status = 'APPROVED'`, [bountyId])).rows[0].n).toBe(0);
      await expect(fBounties.transition(bountyId, 'COMPLETED', adminId)).resolves.toEqual({ id: bountyId, status: 'COMPLETED' });
    });

    it.each(['OPEN', 'SUBMISSION_CLOSED'])('accepts a %s bounty', async (status) => {
      const { adminId, submissionId } = await seedStuck({ bounty: status });
      expect((await forfeit(submissionId, adminId)).code).toBe(0);
      expect(await submissionStatus(submissionId)).toBe('REJECTED');
    });

    type Seeded = Awaited<ReturnType<typeof seedStuck>>;
    it.each<[string, Parameters<typeof seedStuck>[0], ((seed: Seeded) => Promise<string | void>) | null, string]>([
      ['a COMPLETED bounty', { bounty: 'COMPLETED' }, null, 'bounty is COMPLETED'],
      ['a CANCELLED bounty', { bounty: 'CANCELLED' }, null, 'bounty is CANCELLED'],
      ['a DRAFT bounty', { bounty: 'DRAFT' }, null, 'bounty is DRAFT'],
      ['a deleted bounty', {}, async (seed) => { await pool.query(`UPDATE bounty SET deleted_at = now() WHERE id = $1`, [seed.bountyId]); }, 'bounty is deleted'],
      ['a submission that is not APPROVED', { submission: 'IN_REVIEW' }, null, 'not APPROVED'],
      ['an already REJECTED submission', { submission: 'REJECTED' }, null, 'not APPROVED'],
      ['a submission with a CANCELLED payout row', { wallet: true }, async (seed) => {
        await pool.query(
          `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by)
           VALUES ($1, $2, $3, 300, 'CANCELLED', $4, $5)`, [seed.rewardId, seed.submissionId, seed.walletId, unique('forfeit-'), seed.adminId]);
      }, 'runbook.md §7.4'],
      ['a submission with a PAID payout row', { wallet: true }, async (seed) => {
        await pool.query(
          `INSERT INTO payout (bounty_reward_id, submission_id, recipient_wallet_id, amount, status, idempotency_key, requested_by)
           VALUES ($1, $2, $3, 300, 'PAID', $4, $5)`, [seed.rewardId, seed.submissionId, seed.walletId, unique('forfeit-'), seed.adminId]);
      }, 'payout row(s) exist'],
      ['a submission with a completion NFT', { wallet: true }, async (seed) => {
        await pool.query(
          `INSERT INTO nft (owner_user_id, owner_wallet_id, bounty_id, submission_id, nft_type, contract_address)
           VALUES ($1, $2, $3, $4, 'BOUNTY_COMPLETION_CHILD', 'inj1contract')`, [seed.winnerId, seed.walletId, seed.bountyId, seed.submissionId]);
      }, 'completion NFT'],
      ['a non-admin --admin', {}, async () => (await createUser()).id, 'not an active admin'],
      ['a suspended admin', {}, async () => (await createUser({ isAdmin: true, status: 'SUSPENDED' })).id, 'not an active admin'],
      ['a withdrawn admin', {}, async () => {
        const gone = await createUser({ isAdmin: true });
        await pool.query(`UPDATE "user" SET deleted_at = now(), status = 'WITHDRAWN' WHERE id = $1`, [gone.id]);
        return gone.id;
      }, 'not an active admin'],
      ['an unknown --admin', {}, async () => '00000000-0000-4000-8000-000000000000', 'not an active admin'],
    ])('refuses %s and writes nothing', async (_label, options, mutate, message) => {
      const seed = await seedStuck(options);
      const adminOverride = mutate ? await mutate(seed) : undefined;
      const before = await submissionStatus(seed.submissionId);
      const res = await forfeit(seed.submissionId, adminOverride || seed.adminId);
      expect(res.code).toBe(1);
      expect(res.out).toContain(message);
      expect(await submissionStatus(seed.submissionId)).toBe(before);
      expect(await reviews(seed.submissionId)).toEqual([]);
      expect(await auditRows('bounty_submission', seed.submissionId)).toEqual([]);
    });

    it('refuses a missing submission, bad arguments and a declined prompt without writing', async () => {
      const { adminId, submissionId } = await seedStuck();
      const missing = await forfeit('00000000-0000-4000-8000-000000000000', adminId);
      expect(missing.code).toBe(1);
      expect(missing.out).toContain('submission not found');
      expect((await invoke(forfeitAward, [submissionId, '--admin', adminId, '--yes'])).code).toBe(2); // no --reason
      expect((await invoke(forfeitAward, [submissionId, '--reason', '   ', '--admin', adminId, '--yes'])).code).toBe(2);
      expect((await invoke(forfeitAward, [submissionId, '--reason', 'x', '--yes'])).code).toBe(2); // no --admin
      expect((await invoke(forfeitAward, [submissionId, '--reason', 'x', '--admin', 'nope', '--yes'])).code).toBe(2);
      expect((await invoke(forfeitAward, [unique('x'), '--reason', 'x', '--admin', adminId, '--yes'])).code).toBe(2);
      expect((await invoke(forfeitAward, [submissionId, '--reason', 'x', '--admin', adminId, '--yes', '--nope'])).code).toBe(2);
      expect((await invoke(forfeitAward, [submissionId, '--admin', adminId, '--reason'])).code).toBe(2);
      // the operator is told which argument is wrong (the 501st character of the reason, a blank reason, a non-uuid id), not only the usage line
      expect((await invoke(forfeitAward, [submissionId, '--reason', 'x'.repeat(501), '--admin', adminId, '--dry-run'])).out).toContain('--reason must be 1 to 500 characters');
      expect((await invoke(forfeitAward, [submissionId, '--reason', '   ', '--admin', adminId, '--dry-run'])).out).toContain('--reason must be 1 to 500 characters');
      expect((await invoke(forfeitAward, ['not-a-uuid', '--reason', 'x', '--admin', adminId, '--dry-run'])).out).toContain('<submission-id> must be a UUID');
      expect((await invoke(forfeitAward, [submissionId, '--reason', 'x', '--admin', 'nope', '--dry-run'])).out).toContain('--admin must be a user UUID');
      const declined = await forfeit(submissionId, adminId, []);
      expect(declined.code).toBe(1);
      expect(declined.out).toContain('aborted  nothing written');
      expect(await submissionStatus(submissionId)).toBe('APPROVED');
      expect(await reviews(submissionId)).toEqual([]);
      expect(await auditRows('bounty_submission', submissionId)).toEqual([]);
    });

    it('rolls the status change and the review row back when the audit insert fails (same transaction)', async () => {
      const { adminId, submissionId } = await seedStuck();
      await pool.query(`ALTER TABLE audit_log ADD CONSTRAINT tmp_forfeit_block CHECK (action <> 'SUBMISSION_AWARD_FORFEITED') NOT VALID`);
      try {
        await expect(forfeit(submissionId, adminId)).rejects.toThrow();
      } finally {
        await pool.query(`ALTER TABLE audit_log DROP CONSTRAINT tmp_forfeit_block`);
      }
      expect(await submissionStatus(submissionId)).toBe('APPROVED');
      expect(await reviews(submissionId)).toEqual([]);
      expect(await auditRows('bounty_submission', submissionId)).toEqual([]);
    });
  });
});
