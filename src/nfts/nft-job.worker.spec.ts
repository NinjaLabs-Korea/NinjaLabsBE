import { ConfigService } from '@nestjs/config';
import { AlertService } from '../common/alerts/alert.service';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { InjectiveNftClient } from './injective-nft.client';
import { NftJobWorker } from './nft-job.worker';

// 실제 클라이언트는 @injectivelabs/sdk-ts(ESM)를 끌어오므로 DI 메타데이터용 껍데기로 대체한다
jest.mock('./injective-nft.client', () => ({ InjectiveNftClient: class {} }));

describe('NftJobWorker', () => {
  const nftId = '11111111-1111-4111-8111-111111111111';
  const parentId = '22222222-2222-4222-8222-222222222222';

  function setup(options: {
    jobType?: string;
    nft?: Partial<{ nft_type: string; status: string; parent_nft_id: string | null }>;
    configured?: boolean;
    stale?: Array<{ id: string; nft_id: string }>;
    tokenExists?: boolean | Error;
    mnemonic?: string;
    /** claimed batch in RETURNING (heap) order — defaults to one job */
    claimed?: Array<{ id: string; scheduled_at: Date }>;
    /** retry_count the claimed job(s) already carry (default 0) — attempt number = retryCount + 1 */
    retryCount?: number;
    /** per-job re-stamp behaviour: 0 rows = no longer PROCESSING; an Error = the statement itself fails */
    restamp?: Record<string, 0 | Error>;
    /** status of the parent NFT as re-read after a child mint / checked by the attach UPDATE (default MINTED) */
    parentStatus?: string;
    /** rows the MINT_PARENT children scan reports as queued */
    waitingChildren?: number;
  } = {}) {
    const parentReady = ['MINTED', 'ATTACHED'].includes(options.parentStatus ?? 'MINTED');
    const query = jest.fn(withParamsCheck(async (sql: string, params?: unknown[]) => {
      if (sql.includes(`SELECT status FROM nft WHERE id = $1 AND nft_type = 'NINJA_PARENT'`)) {
        return { rowCount: 1, rows: [{ status: options.parentStatus ?? 'MINTED' }] };
      }
      if (sql.includes(`SET status = 'ATTACHED'`)) return parentReady ? { rowCount: 1, rows: [{ id: params![0] }] } : { rowCount: 0, rows: [] };
      if (sql.includes(`'attach-child:' || c.id`)) return { rowCount: options.waitingChildren ?? 0, rows: [] };
      if (sql.includes("interval '15 minutes'")) {
        const rows = options.stale ?? [];
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('UPDATE nft_job') && sql.includes('RETURNING id, nft_id, job_type, retry_count')) {
        const claimed = options.claimed ?? [{ id: 'job', scheduled_at: new Date() }];
        const rows = claimed.map((job) => ({ ...job, nft_id: nftId, job_type: options.jobType ?? 'MINT_CHILD', retry_count: options.retryCount ?? 0 }));
        return { rowCount: rows.length, rows };
      }
      if (sql.includes(`UPDATE nft_job SET started_at = now() WHERE id = $1 AND status = 'PROCESSING' RETURNING id`)) {
        const behaviour = options.restamp?.[params![0] as string];
        if (behaviour instanceof Error) throw behaviour;
        return behaviour === 0 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: params![0] }] };
      }
      if (sql.includes('FROM nft n JOIN wallet w')) {
        return {
          rowCount: 1,
          rows: [{
            id: nftId, nft_type: 'BOUNTY_COMPLETION_CHILD', status: 'PENDING', parent_nft_id: parentId,
            metadata_uri: null, owner_address: 'inj1owner', ...options.nft,
          }],
        };
      }
      return { rowCount: 1, rows: [] };
    }));
    const chain = {
      isConfigured: jest.fn(() => options.configured ?? true),
      contractAddress: jest.fn(() => 'inj1contract'),
      mint: jest.fn(async () => '0xtx'),
      tokenExists: jest.fn(async () => {
        if (options.tokenExists instanceof Error) throw options.tokenExists;
        return options.tokenExists ?? false;
      }),
    };
    const config = { get: jest.fn((key: string) => (key === 'MASTER_WALLET_MNEMONIC' ? options.mnemonic : undefined)) };
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new NftJobWorker(
      { query } as unknown as DatabaseService,
      chain as unknown as InjectiveNftClient,
      config as unknown as ConfigService,
      alerts as unknown as AlertService,
    );
    return { worker, query, chain, alerts };
  }

  it('requeues jobs stuck in PROCESSING for over 15 minutes and resets their MINTING nfts before claiming', async () => {
    const { worker, query } = setup({ configured: false, stale: [{ id: 'stale-job', nft_id: nftId }] });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();

    const sweep = query.mock.calls[0][0] as string;
    expect(sweep).toContain(`SET status = 'PENDING', scheduled_at = now()`);
    expect(sweep).toContain(`WHERE status = 'PROCESSING' AND started_at < now() - interval '15 minutes'`);
    const reset = query.mock.calls[1];
    expect(reset[0]).toContain(`UPDATE nft SET status = 'PENDING' WHERE status = 'MINTING' AND id = ANY($1::uuid[])`);
    expect(reset[1]).toEqual([[nftId]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requeued 1 stale nft_job'));
    // The regular claim still runs afterwards, unchanged.
    expect(query.mock.calls[2][0]).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('raises a rate-limited ops alert (fixed key, count only) when stale PROCESSING jobs are requeued', async () => {
    const { worker, alerts } = setup({ configured: false, stale: [{ id: 'a', nft_id: nftId }, { id: 'b', nft_id: nftId }] });
    jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    expect(alerts.notify).toHaveBeenCalledWith('nft-job-stale-requeue', expect.stringContaining('requeued 2 nft_job(s) stuck in PROCESSING'));
  });

  it('raises no ops alert on an ordinary poll (nothing stale, nothing failed)', async () => {
    const { worker, alerts } = setup({ configured: false });
    await worker.poll();
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('does not touch nft rows or log when nothing is stale', async () => {
    const { worker, query } = setup({ configured: false });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();
    expect(query.mock.calls.some(([sql]) => sql.includes(`WHERE status = 'MINTING' AND id = ANY`))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('claims pending jobs with a single UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING statement', async () => {
    const { worker, query } = setup({ configured: false });
    await worker.poll();

    const claim = query.mock.calls.map(([sql]) => sql as string).find((sql) => sql.includes('FOR UPDATE SKIP LOCKED'))!;
    expect(claim).toContain('UPDATE nft_job');
    expect(claim).toContain(`SET status = 'PROCESSING'`);
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain('RETURNING id, nft_id, job_type, retry_count');
    // No separate autocommit PROCESSING update — the claim itself is the transition.
    const processingUpdates = query.mock.calls.filter(([sql]) =>
      sql.includes(`SET status = 'PROCESSING'`));
    expect(processingUpdates).toHaveLength(1);
    // Unconfigured chain defers the job back to PENDING without touching the nft.
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'PENDING', scheduled_at = now() + interval '1 hour'`))).toBe(true);
  });

  it('re-stamps started_at per job right before processing it, after the batch claim, guarded by the PROCESSING ownership check', async () => {
    const { worker, query } = setup({ configured: false });
    await worker.poll();
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const claim = sqls.findIndex((sql) => sql.includes('FOR UPDATE SKIP LOCKED'));
    const stamp = sqls.findIndex((sql) => sql.includes(`UPDATE nft_job SET started_at = now() WHERE id = $1 AND status = 'PROCESSING' RETURNING id`));
    expect(stamp).toBeGreaterThan(claim);
    expect(query.mock.calls[stamp][1]).toEqual(['job']);
    const defer = sqls.findIndex((sql) => sql.includes(`interval '1 hour'`));
    expect(stamp).toBeLessThan(defer);
  });

  it('skips a claimed job whose re-stamp touches 0 rows (requeued and reclaimed by another instance meanwhile)', async () => {
    const { worker, query, chain } = setup({ restamp: { job: 0 } });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();
    expect(chain.mint).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nft_job job is no longer PROCESSING'));
  });

  it('every per-job terminal UPDATE is fenced by status = PROCESSING, and the failure UPDATE casts every $2 the same way', async () => {
    const { worker, query } = setup({ tokenExists: new Error('boom') });
    await worker.poll();
    const retry = query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))![0] as string;
    expect(retry).toContain(`WHERE id = $1 AND status = 'PROCESSING'`);
    expect(retry.match(/\$2(?!\d)/g)).toHaveLength(3);
    expect(retry.match(/\$2::varchar/g)).toHaveLength(3);

    const { worker: ok, query: okQuery } = setup();
    await ok.poll();
    const success = okQuery.mock.calls.find(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))![0] as string;
    expect(success).toContain(`WHERE id = $1 AND status = 'PROCESSING'`);
  });

  it('does not touch the nft when a late failure finds the job no longer PROCESSING (another instance owns it now)', async () => {
    const { worker, query } = setup({ tokenExists: new Error('late'), claimed: [{ id: 'job', scheduled_at: new Date() }] });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    query.mockImplementation(withParamsCheck(async (sql: string, params?: unknown[]) => {
      if (sql.includes('retry_count = retry_count + 1')) return { rowCount: 0, rows: [] };
      if (sql.includes("interval '15 minutes'")) return { rowCount: 0, rows: [] };
      if (sql.includes('RETURNING id, nft_id, job_type, retry_count')) {
        return { rowCount: 1, rows: [{ id: 'job', nft_id: nftId, job_type: 'MINT_CHILD', retry_count: 4, scheduled_at: new Date() }] };
      }
      if (sql.includes('FROM nft n JOIN wallet w')) {
        return { rowCount: 1, rows: [{ id: nftId, nft_type: 'NINJA_PARENT', status: 'PENDING', parent_nft_id: null, metadata_uri: null, owner_address: 'inj1owner' }] };
      }
      return { rowCount: 1, rows: [{ id: params?.[0] }] };
    }));
    await worker.poll();
    // retry_count 4 + this failure would be the 5th attempt → FAILED, but the job is not ours any more: nft untouched, no permanent-failure log
    expect(query.mock.calls.some(([sql]) => sql.includes(`UPDATE nft SET status = 'FAILED'`))).toBe(false);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nft_job job failed late'));
  });

  it('the 5th failed attempt (retry_count 4 → MAX_RETRY) records the job as FAILED with processed_at, marks the nft FAILED and logs a permanent failure', async () => {
    const { worker, query, chain } = setup({ retryCount: 4, tokenExists: new Error('node unreachable') });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    const recorded = query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))!;
    expect(recorded[1]).toEqual(['job', 'FAILED', 'node unreachable']);
    expect(recorded[0]).toContain(`processed_at = CASE WHEN $2::varchar = 'FAILED' THEN now() ELSE NULL END`);
    expect(recorded[0]).toContain(`WHERE id = $1 AND status = 'PROCESSING'`);
    const nftFailed = query.mock.calls.find(([sql]) => sql.includes(`UPDATE nft SET status = 'FAILED'`))!;
    expect(nftFailed[1]).toEqual([nftId]);
    expect(nftFailed[0]).toContain('WHERE id = $1');
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(false);
    expect(error).toHaveBeenCalledWith('nft_job job failed permanently: node unreachable');
  });

  it('alerts ops once per job type when a job reaches FAILED, with the sanitized error (mnemonic redacted) and no owner address', async () => {
    const mnemonic = 'abandon ability able about above absent';
    const { worker, alerts } = setup({ retryCount: 4, mnemonic, tokenExists: new Error(`sign failed for ${mnemonic}`) });
    jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await worker.poll();
    expect(alerts.notify).toHaveBeenCalledTimes(1);
    const [key, message] = (alerts.notify.mock.calls as unknown as [string, string][])[0];
    expect(key).toBe('nft-job-failed:MINT_CHILD');
    expect(message).toContain(`nft_job job (MINT_CHILD, nft ${nftId}) reached FAILED after 5 attempts: sign failed for [redacted]`);
    expect(message).not.toContain('abandon');
    expect(message).not.toContain('inj1owner');
  });

  it('does not alert on a retryable failure (4th attempt)', async () => {
    const { worker, alerts } = setup({ retryCount: 3, tokenExists: new Error('node unreachable') });
    await worker.poll();
    expect(alerts.notify).not.toHaveBeenCalled();
  });

  it('the 4th failed attempt (retry_count 3) still schedules a retry and leaves the nft alone', async () => {
    const { worker, query } = setup({ retryCount: 3, tokenExists: new Error('node unreachable') });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await worker.poll();
    expect(query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))![1]).toEqual(['job', 'PENDING', 'node unreachable']);
    expect(query.mock.calls.some(([sql]) => sql.includes(`UPDATE nft SET status = 'FAILED'`))).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('processes the claimed batch in scheduled_at order regardless of RETURNING (heap) order', async () => {
    const { worker, query } = setup({
      configured: false,
      claimed: [{ id: 'later', scheduled_at: new Date('2026-01-01T00:10:00Z') }, { id: 'earlier', scheduled_at: new Date('2026-01-01T00:00:00Z') }],
    });
    await worker.poll();
    const stamps = query.mock.calls.filter(([sql]) => sql.includes(`SET started_at = now() WHERE id = $1 AND status = 'PROCESSING'`)).map(([, params]) => params![0]);
    expect(stamps).toEqual(['earlier', 'later']);
  });

  it('logs with the job id and continues the batch when processing one job throws', async () => {
    const { worker, query, chain } = setup({
      claimed: [{ id: 'broken', scheduled_at: new Date('2026-01-01T00:00:00Z') }, { id: 'healthy', scheduled_at: new Date('2026-01-01T00:01:00Z') }],
      restamp: { broken: new Error('connection terminated unexpectedly') },
    });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await expect(worker.poll()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('nft_job broken processing threw: connection terminated unexpectedly');
    // the healthy job still ran to completion
    expect(chain.mint).toHaveBeenCalledTimes(1);
    const succeeded = query.mock.calls.filter(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`));
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0][1]).toEqual(['healthy']);
    expect(worker['running']).toBe(false);
  });

  it('asks the chain whether the token exists before minting and mints only when it does not', async () => {
    const { worker, query, chain } = setup();
    await worker.poll();
    expect(chain.tokenExists).toHaveBeenCalledWith(nftId);
    expect(chain.tokenExists.mock.invocationCallOrder[0]).toBeLessThan(chain.mint.mock.invocationCallOrder[0]);
    const minted = query.mock.calls.find(([sql]) => sql.includes(`SET status = 'MINTED'`))!;
    expect(minted[0]).toContain('mint_tx_hash = $3');
    expect(minted[1]).toEqual([nftId, nftId, '0xtx', 'inj1contract']);
  });

  it('recovers a token minted by a crashed run as MINTED without re-minting and leaves mint_tx_hash untouched', async () => {
    const { worker, query, chain } = setup({ tokenExists: true });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    const recovered = query.mock.calls.find(([sql]) => sql.includes(`SET status = 'MINTED'`))!;
    expect(recovered[0]).toContain(`SET status = 'MINTED', token_id = $2, contract_address = $3, minted_at = now()`);
    expect(recovered[0]).not.toContain('mint_tx_hash');
    expect(recovered[1]).toEqual([nftId, nftId, 'inj1contract']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already minted on chain'));
    // The job still completes and the child attach is still queued.
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes(`'ATTACH_CHILD'`))).toBe(true);
  });

  it('retries the job instead of minting when the existence check fails with a network error', async () => {
    const { worker, query, chain } = setup({ tokenExists: new Error('ECONNREFUSED grpc') });
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    const retry = query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))!;
    expect(retry[1]).toEqual(['job', 'PENDING', 'ECONNREFUSED grpc']);
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'MINTED'`))).toBe(false);
  });

  describe('last_error hygiene', () => {
    const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

    it('redacts every occurrence of the master wallet mnemonic (any whitespace between words, any case) before storing last_error', async () => {
      const leak = new Error(`broadcast failed for signer ${mnemonic} (retrying)\n  mnemonic:\t${mnemonic.toUpperCase().replace(/ /g, '  ')}`);
      const { worker, query } = setup({ tokenExists: leak, mnemonic });
      const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
      await worker.poll();
      const retry = query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))!;
      const stored = retry[1]![2] as string;
      expect(stored).toBe('broadcast failed for signer [redacted] (retrying)\n  mnemonic:\t[redacted]');
      expect(stored.toLowerCase()).not.toContain('abandon ability');
      expect(error).not.toHaveBeenCalled();
    });

    it('truncates last_error to 500 characters', async () => {
      const { worker, query } = setup({ tokenExists: new Error('x'.repeat(2000)) });
      await worker.poll();
      const retry = query.mock.calls.find(([sql]) => sql.includes('retry_count = retry_count + 1'))!;
      const stored = retry[1]![2] as string;
      expect(stored).toHaveLength(500);
      expect(stored.endsWith('…')).toBe(true);
    });

    it('leaves ordinary errors untouched when no mnemonic is configured', () => {
      const { worker } = setup();
      expect(worker.sanitizeError(new Error('ECONNREFUSED grpc'))).toBe('ECONNREFUSED grpc');
      expect(worker.sanitizeError('plain string')).toBe('plain string');
    });

    it.each([
      ['comma-joined', 'words: abandon,ability,able,about,above,absent,absorb,abstract,absurd,abuse,access,accident!', 'words: [redacted]!'],
      ['mixed separators', 'abandon\tability\nable / about', '[redacted]'],
      ['a partial run in a different order', 'signer "about able abandon" rejected', 'signer "[redacted]" rejected'],
      ['exactly three words', 'absurd-abuse-access', '[redacted]'],
      ['upper case', 'ABSENT ABSORB ABSTRACT', '[redacted]'],
      ['two runs', 'a abandon ability able b above absent absorb c', 'a [redacted] b [redacted] c'],
    ])('redacts any run of 3+ mnemonic words (%s)', (_label, input, expected) => {
      const { worker } = setup({ mnemonic });
      expect(worker.sanitizeError(new Error(input))).toBe(expected);
    });

    it.each([
      'about access denied',               // only two mnemonic words in a row
      'able to access the node',           // interrupted by non-mnemonic words
      'abandonment ability ablest',        // no exact word matches
    ])('does not redact ordinary prose that merely contains mnemonic words: %p', (input) => {
      const { worker } = setup({ mnemonic });
      expect(worker.sanitizeError(new Error(input))).toBe(input);
    });

    it('redacts 64-hex private keys with and without the 0x prefix, even with no mnemonic configured', () => {
      const { worker } = setup();
      const key = 'a'.repeat(32) + 'B'.repeat(32);
      expect(worker.sanitizeError(new Error(`pk=${key} rejected`))).toBe('pk=[redacted] rejected');
      expect(worker.sanitizeError(new Error(`pk=0x${key}; retry`))).toBe('pk=[redacted]; retry');
      // 63 or 65 hex chars and longer hex blobs are not keys
      expect(worker.sanitizeError(new Error(`hash ${'a'.repeat(63)}`))).toBe(`hash ${'a'.repeat(63)}`);
      expect(worker.sanitizeError(new Error(`blob ${'a'.repeat(65)}`))).toBe(`blob ${'a'.repeat(65)}`);
    });
  });

  const childAttachEnqueue = (query: jest.Mock) => query.mock.calls.find(([sql, params]) => sql.includes(`'ATTACH_CHILD'`) && params?.[1] === `attach-child:${nftId}`);

  it('enqueues ATTACH_CHILD after a child mint succeeds when the parent NFT is MINTED, re-reading the parent after the child is MINTED', async () => {
    const { worker, query, chain } = setup();
    await worker.poll();

    expect(chain.mint).toHaveBeenCalledWith(nftId, 'inj1owner', null);
    const attach = childAttachEnqueue(query);
    expect(attach).toBeDefined();
    expect(attach![0]).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(attach![1]).toEqual([nftId, `attach-child:${nftId}`]);
    // the parent status is read after the child's MINTED update, not from the initial row read (closes the parent/child race)
    const sqls = query.mock.calls.map(([sql]) => sql as string);
    const minted = sqls.findIndex((sql) => sql.includes(`SET status = 'MINTED'`));
    const parentRead = sqls.findIndex((sql) => sql.includes(`SELECT status FROM nft WHERE id = $1 AND nft_type = 'NINJA_PARENT'`));
    expect(parentRead).toBeGreaterThan(minted);
    expect(query.mock.calls[parentRead][1]).toEqual([parentId]);
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true);
  });

  it('also enqueues ATTACH_CHILD when the parent is already ATTACHED, and when the mint job is retried after the child was already MINTED', async () => {
    const attachedParent = setup({ parentStatus: 'ATTACHED' });
    await attachedParent.worker.poll();
    expect(childAttachEnqueue(attachedParent.query)).toBeDefined();

    const retried = setup({ nft: { status: 'MINTED' } });
    await retried.worker.poll();
    expect(retried.chain.mint).not.toHaveBeenCalled();
    expect(childAttachEnqueue(retried.query)).toBeDefined();
  });

  it.each(['PENDING', 'MINTING', 'FAILED'])('leaves a freshly minted child MINTED (no ATTACH_CHILD) while its parent is %s', async (parentStatus) => {
    const { worker, query } = setup({ parentStatus });
    await worker.poll();

    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'MINTED'`))).toBe(true);
    expect(childAttachEnqueue(query)).toBeUndefined();
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true); // the mint job itself is done
  });

  it.each([
    ['child without a parent (attach deferred)', { parent_nft_id: null }],
    ['child already attached', { status: 'ATTACHED' }],
  ])('does not enqueue ATTACH_CHILD for a %s', async (_label, nft) => {
    const { worker, query } = setup({ nft });
    await worker.poll();

    expect(query.mock.calls.some(([sql]) => sql.includes(`'ATTACH_CHILD'`))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes(`nft_type = 'NINJA_PARENT'`))).toBe(false);
  });

  it('after MINT_PARENT succeeds, enqueues ATTACH_CHILD for every MINTED child linked to that parent (idempotent key, deferred jobs pulled forward)', async () => {
    const { worker, query } = setup({ jobType: 'MINT_PARENT', nft: { nft_type: 'NINJA_PARENT', parent_nft_id: null }, waitingChildren: 2 });
    const log = jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
    await worker.poll();

    const scan = query.mock.calls.find(([sql]) => sql.includes(`'attach-child:' || c.id`))!;
    expect(scan[0]).toContain(`INSERT INTO nft_job (nft_id, job_type, idempotency_key)`);
    expect(scan[0]).toContain(`WHERE c.parent_nft_id = $1 AND c.nft_type = 'BOUNTY_COMPLETION_CHILD' AND c.status = 'MINTED'`);
    expect(scan[0]).toContain(`ON CONFLICT (idempotency_key) DO UPDATE SET scheduled_at = now()`);
    expect(scan[0]).toContain(`WHERE nft_job.status = 'PENDING'`);
    expect(scan[1]).toEqual([nftId]);
    expect(childAttachEnqueue(query)).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('queued ATTACH_CHILD for 2 waiting child NFT(s)'));
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true);
  });

  it('transitions MINTED → ATTACHED for an ATTACH_CHILD job only through the parent-ready join (DB-only, no chain call)', async () => {
    const { worker, query, chain } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'MINTED' } });
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    const attach = query.mock.calls.find(([sql]) => sql.includes(`SET status = 'ATTACHED'`))!;
    expect(attach[0]).toContain(`AND p.id = c.parent_nft_id AND p.status IN ('MINTED', 'ATTACHED')`);
    expect(attach[1]).toEqual([nftId]);
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true);
  });

  it('defers an ATTACH_CHILD job (PENDING, +1 hour, retry_count untouched) when the parent is not minted yet, instead of succeeding or failing', async () => {
    const { worker, query } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'MINTED' }, parentStatus: 'PENDING' });
    const log = jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
    await worker.poll();

    const defer = query.mock.calls.find(([sql]) => sql.includes('attach deferred'))!;
    expect(defer[0]).toContain(`SET status = 'PENDING', scheduled_at = now() + interval '1 hour'`);
    expect(defer[0]).toContain(`WHERE id = $1 AND status = 'PROCESSING'`);
    expect(defer[1]).toEqual(['job']);
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('retry_count = retry_count + 1'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nft_job job deferred'));
  });

  it('closes an ATTACH_CHILD job as done without an UPDATE when the child is already ATTACHED', async () => {
    const { worker, query } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'ATTACHED' } });
    await worker.poll();
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'ATTACHED'`))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes(`SET status = 'SUCCEEDED'`))).toBe(true);
  });
});
