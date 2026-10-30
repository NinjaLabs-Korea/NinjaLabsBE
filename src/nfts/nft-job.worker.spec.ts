import { ConfigService } from '@nestjs/config';
import { AlertService } from '../common/alerts/alert.service';
import { createMockDb, type SqlHandler } from '../test-support/mock-db';
import { InjectiveNftClient } from './injective-nft.client';
import { JOB_EXECUTION_DEADLINE_MS, NftJobWorker } from './nft-job.worker';

// 실제 클라이언트는 @injectivelabs/sdk-ts(ESM)를 끌어오므로 DI 메타데이터용 껍데기로 대체한다
jest.mock('./injective-nft.client', () => ({ InjectiveNftClient: class {} }));

/**
 * 이 스펙은 분기(재시도 횟수 계산, 에러 정제, 마감, 종료 드레인, 잡 종류별 라우팅)만 본다. 엄격 mock DB라서 아래 STMT에 없는 SQL이
 * 나가면 `Unexpected SQL`로 실패한다 (예전처럼 `{ rowCount: 1, rows: [] }`로 조용히 통과하지 않는다). 문장 매칭은 공백을 접은 SQL에
 * 적용되므로 줄바꿈/들여쓰기만 바꾼 SQL 수정에는 깨지지 않는다.
 * SQL 문장 자체(WHERE 가드, 선점/SKIP LOCKED, `$2::varchar` 캐스트, 멱등 키)와 그 결과 행은 실 Postgres 위의
 * `src/test-db/nft-worker.db-spec.ts`가 행 단언으로 검증한다.
 */
const STMT = {
  stale: /^UPDATE nft_job SET status = 'PENDING', scheduled_at = now\(\), claim_token = NULL WHERE status = 'PROCESSING' AND started_at </,
  resetMinting: /^UPDATE nft SET status = 'PENDING' WHERE status = 'MINTING'/,
  claim: /^UPDATE nft_job SET status = 'PROCESSING', started_at = now\(\), claim_token = gen_random_uuid\(\) WHERE id IN/,
  claimLock: /^SELECT id FROM nft_job WHERE id = \$1 AND status = 'PROCESSING' AND claim_token = \$2 FOR UPDATE$/,
  holdTail: /^UPDATE nft_job SET started_at = now\(\) WHERE \(id, claim_token\) IN/,
  restamp: /^UPDATE nft_job SET started_at = now\(\) WHERE id = \$1/,
  loadNft: /FROM nft n JOIN wallet w/,
  deferUnconfigured: /^UPDATE nft_job SET status = 'PENDING', scheduled_at = now\(\) \+ interval '1 hour', claim_token = NULL, last_error = 'NFT_CONTRACT_ADDRESS/,
  deferAttach: /^UPDATE nft_job SET status = 'PENDING', scheduled_at = now\(\) \+ interval '1 hour', claim_token = NULL, last_error = 'parent NFT not minted yet/,
  succeeded: /^UPDATE nft_job SET status = 'SUCCEEDED'/,
  recordFailure: /^UPDATE nft_job SET status = \$2::varchar, retry_count = retry_count \+ 1/,
  nftFailed: /^UPDATE nft SET status = 'FAILED'/,
  minting: /^UPDATE nft SET status = 'MINTING'/,
  mintedFresh: /^UPDATE nft SET status = 'MINTED', token_id = \$2, mint_tx_hash = \$3/,
  mintedRecovered: /^UPDATE nft SET status = 'MINTED', token_id = \$2, contract_address = \$3/,
  parentRead: /^SELECT status FROM nft WHERE id = \$1 AND nft_type = 'NINJA_PARENT'/,
  parentScan: /^INSERT INTO nft_job .* SELECT c\.id, 'ATTACH_CHILD'/,
  attachEnqueue: /^INSERT INTO nft_job .* VALUES \(\$1, 'ATTACH_CHILD'/,
  attach: /^UPDATE nft c SET status = 'ATTACHED'/,
  release: /^UPDATE nft_job SET status = 'PENDING', claim_token = NULL WHERE \(id, claim_token\) IN/,
} as const;

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
    /** claimed batch in RETURNING (heap) order: defaults to one job */
    claimed?: Array<{ id: string; scheduled_at: Date }>;
    /** retry_count the claimed job(s) already carry (default 0): attempt number = retryCount + 1 */
    retryCount?: number;
    /** per-job re-stamp behaviour: 0 rows = no longer PROCESSING; an Error = the statement itself fails */
    restamp?: Record<string, 0 | Error>;
    /** status of the parent NFT as re-read after a child mint / checked by the attach UPDATE (default MINTED) */
    parentStatus?: string;
    /** rows the MINT_PARENT children scan reports as queued */
    waitingChildren?: number;
  } = {}) {
    /** 순서가 의미인 사건(DB 문장 + 체인 호출)을 호출 순서대로 모은다 - mock.calls 위치 대신 이것을 단언한다 */
    const events: string[] = [];
    const parentReady = ['MINTED', 'ATTACHED'].includes(options.parentStatus ?? 'MINTED');
    const on = (match: RegExp, reply: SqlHandler['reply']): SqlHandler => ({ match, reply });
    const mock = createMockDb({
      strict: true,
      handlers: [
        on(STMT.claimLock, () => ({ rowCount: 1, rows: [{ id: 'job' }] })),
        on(STMT.parentRead, () => ({ rowCount: 1, rows: [{ status: options.parentStatus ?? 'MINTED' }] })),
        on(STMT.attach, (params) => (parentReady ? { rowCount: 1, rows: [{ id: params![0] }] } : { rowCount: 0, rows: [] })),
        on(STMT.parentScan, () => ({ rowCount: options.waitingChildren ?? 0, rows: [] })),
        on(STMT.attachEnqueue, () => { events.push('enqueue ATTACH_CHILD'); return { rowCount: 1, rows: [] }; }),
        on(STMT.stale, () => {
          const rows = options.stale ?? [];
          return { rowCount: rows.length, rows };
        }),
        on(STMT.resetMinting, () => ({ rowCount: 1, rows: [] })),
        on(STMT.claim, () => {
          const claimed = options.claimed ?? [{ id: 'job', scheduled_at: new Date() }];
          const rows = claimed.map((job) => ({ ...job, claim_token: `claim:${job.id}`, nft_id: nftId, job_type: options.jobType ?? 'MINT_CHILD', retry_count: options.retryCount ?? 0 }));
          return { rowCount: rows.length, rows };
        }),
        on(STMT.holdTail, () => ({ rowCount: 1, rows: [] })),
        on(STMT.restamp, (params) => {
          const behaviour = options.restamp?.[params![0] as string];
          if (behaviour instanceof Error) throw behaviour;
          return behaviour === 0 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: params![0] }] };
        }),
        on(STMT.loadNft, () => ({
          rowCount: 1,
          rows: [{
            id: nftId, nft_type: 'BOUNTY_COMPLETION_CHILD', status: 'PENDING', parent_nft_id: parentId,
            metadata_uri: null, owner_address: 'inj1owner', ...options.nft,
          }],
        })),
        on(STMT.minting, () => { events.push('MINTING'); return { rowCount: 1, rows: [] }; }),
        on(STMT.mintedFresh, () => { events.push('MINTED'); return { rowCount: 1, rows: [] }; }),
        on(STMT.mintedRecovered, () => { events.push('MINTED (recovered)'); return { rowCount: 1, rows: [] }; }),
        on(STMT.deferUnconfigured, () => ({ rowCount: 1, rows: [] })),
        on(STMT.deferAttach, () => ({ rowCount: 1, rows: [] })),
        on(STMT.succeeded, () => ({ rowCount: 1, rows: [] })),
        on(STMT.recordFailure, () => ({ rowCount: 1, rows: [] })),
        on(STMT.nftFailed, () => ({ rowCount: 1, rows: [] })),
        on(STMT.release, (params) => ({ rowCount: (params![0] as unknown[]).length, rows: [] })),
      ],
    });
    // Keep the existing ordered statement/event assertions across both pool and claim-locked transactions.
    mock.txQuery.mockImplementation((sql: string, params?: unknown[]) => mock.query(sql, params));
    const chain = {
      isConfigured: jest.fn(() => options.configured ?? true),
      contractAddress: jest.fn(() => 'inj1contract'),
      mint: jest.fn(async () => { events.push('chain.mint'); return '0xtx'; }),
      tokenExists: jest.fn(async () => {
        if (options.tokenExists instanceof Error) throw options.tokenExists;
        return options.tokenExists ?? false;
      }),
    };
    const config = { get: jest.fn((key: string) => (key === 'MASTER_WALLET_MNEMONIC' ? options.mnemonic : undefined)) };
    const alerts = { notify: jest.fn(async () => true) };
    const worker = new NftJobWorker(
      mock.database,
      chain as unknown as InjectiveNftClient,
      config as unknown as ConfigService,
      alerts as unknown as AlertService,
    );
    const stmts = (match: RegExp) => mock.statements(match);
    /** 해당 문장이 한 번이라도 나갔는가 */
    const ran = (match: RegExp) => stmts(match).length > 0;
    /** 해당 문장들의 첫 바인딩(보통 잡 id) */
    const firstParams = (match: RegExp) => stmts(match).map(({ params }) => params![0]);
    /** 잡의 실패 기록 UPDATE에 실린 [id, 다음 상태, last_error] */
    const failureRecorded = () => stmts(STMT.recordFailure).map(({ params }) => params?.slice(0, 3));
    return { worker, query: mock.query, mock, chain, alerts, events, stmts, ran, firstParams, failureRecorded };
  }

  it('requeues jobs stuck in PROCESSING for over 15 minutes and resets only their MINTING nfts, then still claims', async () => {
    const { worker, stmts } = setup({ configured: false, stale: [{ id: 'stale-job', nft_id: nftId }] });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();

    expect(stmts(STMT.resetMinting).map(({ params }) => params)).toEqual([[[nftId]]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requeued 1 stale nft_job'));
    expect(stmts(STMT.claim)).toHaveLength(1); // the regular claim still runs afterwards
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
    const { worker, ran } = setup({ configured: false });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();
    expect(ran(STMT.resetMinting)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the unstarted tail of a slow batch alive: refreshes the remaining jobs\' started_at before each job so a peer stale sweep cannot reclaim them', async () => {
    const { worker, firstParams } = setup({
      configured: false,
      claimed: [{ id: 'a', scheduled_at: new Date('2026-01-01T00:00:00Z') }, { id: 'b', scheduled_at: new Date('2026-01-01T00:01:00Z') }, { id: 'c', scheduled_at: new Date('2026-01-01T00:02:00Z') }],
    });
    await worker.poll();
    expect(firstParams(STMT.holdTail)).toEqual([['b', 'c'], ['c']]);
  });

  it('processes the claimed batch in scheduled_at order regardless of RETURNING (heap) order', async () => {
    const t = new Date('2026-01-01T00:00:00Z').getTime();
    const { worker, firstParams } = setup({
      configured: false,
      claimed: [{ id: 'later', scheduled_at: new Date(t + 10 * 60_000) }, { id: 'earlier', scheduled_at: new Date(t) }],
    });
    await worker.poll();
    expect(firstParams(STMT.restamp)).toEqual(['earlier', 'later']);
  });

  it('skips a claimed job whose re-stamp touches 0 rows (requeued and reclaimed by another instance meanwhile)', async () => {
    const { worker, ran, chain } = setup({ restamp: { job: 0 } });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();
    expect(chain.mint).not.toHaveBeenCalled();
    expect(ran(STMT.succeeded)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('nft_job job is no longer PROCESSING'));
  });

  it('the 5th failed attempt (retry_count 4 → MAX_RETRY) records FAILED, marks the nft FAILED and logs a permanent failure', async () => {
    const { worker, chain, failureRecorded, firstParams, ran } = setup({ retryCount: 4, tokenExists: new Error('node unreachable') });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    expect(failureRecorded()).toEqual([['job', 'FAILED', 'node unreachable']]);
    expect(firstParams(STMT.nftFailed)).toEqual([nftId]);
    expect(ran(STMT.succeeded)).toBe(false);
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
    const { worker, failureRecorded, ran } = setup({ retryCount: 3, tokenExists: new Error('node unreachable') });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await worker.poll();
    expect(failureRecorded()).toEqual([['job', 'PENDING', 'node unreachable']]);
    expect(ran(STMT.nftFailed)).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });

  it('logs with the job id and continues the batch when processing one job throws', async () => {
    const { worker, chain, firstParams, stmts } = setup({
      claimed: [{ id: 'broken', scheduled_at: new Date('2026-01-01T00:00:00Z') }, { id: 'healthy', scheduled_at: new Date('2026-01-01T00:01:00Z') }],
      restamp: { broken: new Error('connection terminated unexpectedly') },
    });
    const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
    await expect(worker.poll()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('nft_job broken processing threw: connection terminated unexpectedly');
    // the healthy job still ran to completion
    expect(chain.mint).toHaveBeenCalledTimes(1);
    expect(stmts(STMT.succeeded)).toHaveLength(1);
    expect(firstParams(STMT.succeeded)).toEqual(['healthy']);
    expect(worker['polling'].isRunning).toBe(false);
  });

  it('asks the chain whether the token exists before minting and mints only when it does not', async () => {
    const { worker, chain, stmts } = setup();
    await worker.poll();
    expect(chain.tokenExists).toHaveBeenCalledWith(nftId);
    expect(chain.tokenExists.mock.invocationCallOrder[0]).toBeLessThan(chain.mint.mock.invocationCallOrder[0]);
    expect(stmts(STMT.mintedFresh).map(({ params }) => params)).toEqual([[nftId, nftId, '0xtx', 'inj1contract']]);
  });

  it('recovers a token minted by a crashed run as MINTED without re-minting', async () => {
    const { worker, chain, stmts, ran } = setup({ tokenExists: true });
    const warn = jest.spyOn(worker['logger'], 'warn').mockImplementation(() => undefined);
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    // only the recovery statement (no mint_tx_hash column) is registered, so the strict mock would reject the fresh-mint statement
    expect(stmts(STMT.mintedRecovered).map(({ params }) => params)).toEqual([[nftId, nftId, 'inj1contract']]);
    expect(ran(STMT.mintedFresh)).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already minted on chain'));
    // The job still completes and the child attach is still queued.
    expect(ran(STMT.succeeded)).toBe(true);
    expect(ran(STMT.attachEnqueue)).toBe(true);
  });

  it('retries the job instead of minting when the existence check fails with a network error', async () => {
    const { worker, chain, failureRecorded, ran } = setup({ tokenExists: new Error('ECONNREFUSED grpc') });
    await worker.poll();

    expect(chain.mint).not.toHaveBeenCalled();
    expect(failureRecorded()).toEqual([['job', 'PENDING', 'ECONNREFUSED grpc']]);
    expect(ran(STMT.mintedFresh)).toBe(false);
    expect(ran(STMT.mintedRecovered)).toBe(false);
  });

  describe('last_error hygiene', () => {
    const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

    it('redacts every occurrence of the master wallet mnemonic (any whitespace between words, any case) before storing last_error', async () => {
      const leak = new Error(`broadcast failed for signer ${mnemonic} (retrying)\n  mnemonic:\t${mnemonic.toUpperCase().replace(/ /g, '  ')}`);
      const { worker, failureRecorded } = setup({ tokenExists: leak, mnemonic });
      const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
      await worker.poll();
      const stored = failureRecorded()[0]![2] as string;
      expect(stored).toBe('broadcast failed for signer [redacted] (retrying)\n  mnemonic:\t[redacted]');
      expect(stored.toLowerCase()).not.toContain('abandon ability');
      expect(error).not.toHaveBeenCalled();
    });

    it('truncates last_error to 500 characters', async () => {
      const { worker, failureRecorded } = setup({ tokenExists: new Error('x'.repeat(2000)) });
      await worker.poll();
      const stored = failureRecorded()[0]![2] as string;
      expect(stored).toHaveLength(500);
      expect(stored.endsWith('…')).toBe(true);
    });

    it('leaves ordinary errors untouched when no mnemonic is configured', () => {
      const { worker } = setup();
      expect(worker.sanitizeError(new Error('ECONNREFUSED grpc'))).toBe('ECONNREFUSED grpc');
      expect(worker.sanitizeError('plain string')).toBe('plain string');
    });

    it('drops NUL characters that Postgres would reject in last_error', () => {
      const { worker } = setup();
      expect(worker.sanitizeError(new Error('bad\u0000bytes'))).toBe('badbytes');
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

  describe('ATTACH_CHILD enqueue branches after a child mint', () => {
    it('enqueues ATTACH_CHILD for the child after its mint when the parent NFT is MINTED, reading the parent only after the child is MINTED', async () => {
      const { worker, chain, stmts, events } = setup();
      await worker.poll();

      expect(chain.mint).toHaveBeenCalledWith(nftId, 'inj1owner', null);
      expect(stmts(STMT.attachEnqueue).map(({ params }) => params)).toEqual([[nftId, `attach-child:${nftId}`]]);
      expect(stmts(STMT.parentRead).map(({ params }) => params)).toEqual([[parentId]]);
      expect(events).toEqual(['MINTING', 'chain.mint', 'MINTED', 'enqueue ATTACH_CHILD']);
    });

    it('also enqueues ATTACH_CHILD when the parent is already ATTACHED, and when the mint job is retried after the child was already MINTED', async () => {
      const attachedParent = setup({ parentStatus: 'ATTACHED' });
      await attachedParent.worker.poll();
      expect(attachedParent.ran(STMT.attachEnqueue)).toBe(true);

      const retried = setup({ nft: { status: 'MINTED' } });
      await retried.worker.poll();
      expect(retried.chain.mint).not.toHaveBeenCalled();
      expect(retried.ran(STMT.attachEnqueue)).toBe(true);
    });

    it.each(['PENDING', 'MINTING', 'FAILED'])('leaves a freshly minted child MINTED (no ATTACH_CHILD) while its parent is %s', async (parentStatus) => {
      const { worker, ran } = setup({ parentStatus });
      await worker.poll();

      expect(ran(STMT.mintedFresh)).toBe(true);
      expect(ran(STMT.attachEnqueue)).toBe(false);
      expect(ran(STMT.succeeded)).toBe(true); // the mint job itself is done
    });

    it.each([
      ['child without a parent (attach deferred)', { parent_nft_id: null }],
      ['child already attached', { status: 'ATTACHED' }],
    ])('does not enqueue ATTACH_CHILD (nor read the parent) for a %s', async (_label, nft) => {
      const { worker, ran } = setup({ nft });
      await worker.poll();

      expect(ran(STMT.attachEnqueue)).toBe(false);
      expect(ran(STMT.parentRead)).toBe(false);
    });

    it('after MINT_PARENT succeeds, scans the parent\'s waiting children instead of enqueueing a single attach, and logs how many were queued', async () => {
      const { worker, stmts, ran } = setup({ jobType: 'MINT_PARENT', nft: { nft_type: 'NINJA_PARENT', parent_nft_id: null }, waitingChildren: 2 });
      const log = jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
      await worker.poll();

      expect(stmts(STMT.parentScan).map(({ params }) => params)).toEqual([[nftId]]);
      expect(ran(STMT.attachEnqueue)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('queued ATTACH_CHILD for 2 waiting child NFT(s)'));
      expect(ran(STMT.succeeded)).toBe(true);
    });

    it('stays quiet when the parent has no waiting children', async () => {
      const { worker, stmts } = setup({ jobType: 'MINT_PARENT', nft: { nft_type: 'NINJA_PARENT', parent_nft_id: null }, waitingChildren: 0 });
      const log = jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
      await worker.poll();
      expect(stmts(STMT.parentScan)).toHaveLength(1);
      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('ATTACH_CHILD / RETRY_ATTACH', () => {
    it('attaches a MINTED child through the parent-ready join (DB-only, no chain call)', async () => {
      const { worker, chain, stmts, ran } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'MINTED' } });
      await worker.poll();

      expect(chain.mint).not.toHaveBeenCalled();
      expect(chain.tokenExists).not.toHaveBeenCalled();
      expect(stmts(STMT.attach).map(({ params }) => params)).toEqual([[nftId]]);
      expect(ran(STMT.succeeded)).toBe(true);
    });

    it('defers (not succeeds, not fails) an ATTACH_CHILD job when the parent is not minted yet, consuming no retry', async () => {
      const { worker, firstParams, ran } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'MINTED' }, parentStatus: 'PENDING' });
      const log = jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
      await worker.poll();

      expect(firstParams(STMT.deferAttach)).toEqual(['job']);
      expect(ran(STMT.succeeded)).toBe(false);
      expect(ran(STMT.recordFailure)).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('nft_job job deferred'));
    });

    it('closes an ATTACH_CHILD job as done without an attach UPDATE when the child is already ATTACHED', async () => {
      const { worker, ran } = setup({ jobType: 'ATTACH_CHILD', nft: { status: 'ATTACHED' } });
      await worker.poll();
      expect(ran(STMT.attach)).toBe(false);
      expect(ran(STMT.succeeded)).toBe(true);
    });

    it('RETRY_ATTACH attaches an ATTACHING child like ATTACH_CHILD', async () => {
      const { worker, stmts, ran } = setup({ jobType: 'RETRY_ATTACH', nft: { status: 'ATTACHING' } });
      await worker.poll();
      expect(stmts(STMT.attach).map(({ params }) => params)).toEqual([[nftId]]);
      expect(ran(STMT.succeeded)).toBe(true);
    });

    it.each(['PENDING', 'MINTING', 'FAILED'])('an ATTACH_CHILD for a child that is %s (not minted) fails as a retry instead of deferring or succeeding', async (status) => {
      const { worker, failureRecorded, ran } = setup({ jobType: 'ATTACH_CHILD', nft: { status }, parentStatus: 'PENDING' });
      await worker.poll();
      expect(failureRecorded()).toEqual([['job', 'PENDING', `nft ${nftId} cannot be attached in status ${status}`]]);
      expect(ran(STMT.deferAttach)).toBe(false);
    });
  });

  describe('job routing edge cases', () => {
    it('an unconfigured chain defers the job, burning no retry and calling no chain method', async () => {
      const { worker, chain, firstParams, ran } = setup({ configured: false, retryCount: 4 });
      await worker.poll();
      expect(firstParams(STMT.deferUnconfigured)).toEqual(['job']);
      expect(ran(STMT.recordFailure)).toBe(false);
      expect(chain.tokenExists).not.toHaveBeenCalled();
      expect(chain.mint).not.toHaveBeenCalled();
      // even on what would be the last attempt, the nft is not failed
      expect(ran(STMT.nftFailed)).toBe(false);
    });

    it('a job of an unknown type is retried with last_error naming the type (no chain call)', async () => {
      const { worker, chain, failureRecorded } = setup({ jobType: 'BURN' });
      await worker.poll();
      expect(failureRecorded()).toEqual([['job', 'PENDING', 'unknown job_type: BURN']]);
      expect(chain.mint).not.toHaveBeenCalled();
    });

    it('a job whose nft row is gone is retried with "not found" (the wallet join found nothing)', async () => {
      const { worker, mock, failureRecorded } = setup();
      mock.handle(STMT.loadNft, () => ({ rowCount: 0, rows: [] }));
      await worker.poll();
      expect(failureRecorded()).toEqual([['job', 'PENDING', `nft ${nftId} not found`]]);
    });

    it('RETRY_MINT (operator retry of a FAILED nft) mints like MINT_CHILD: MINTING, then the chain mint, then MINTED, then the job is closed', async () => {
      const { worker, events, ran } = setup({ jobType: 'RETRY_MINT', nft: { status: 'FAILED' }, parentStatus: 'PENDING' });
      await worker.poll();
      expect(events).toEqual(['MINTING', 'chain.mint', 'MINTED']);
      expect(ran(STMT.succeeded)).toBe(true);
    });

    it('a mint broadcast failure is recorded as a retry with the (sanitized) chain error and the nft is never marked MINTED', async () => {
      const { worker, chain, failureRecorded, ran } = setup();
      chain.mint.mockRejectedValueOnce(new Error('account sequence mismatch'));
      await worker.poll();
      expect(failureRecorded()).toEqual([['job', 'PENDING', 'account sequence mismatch']]);
      expect(ran(STMT.mintedFresh)).toBe(false);
      expect(ran(STMT.succeeded)).toBe(false);
    });

    it('a poll that starts while another is still running does nothing (re-entrancy guard), and the flag is released afterwards', async () => {
      const { worker, query } = setup({ configured: false });
      const base = query.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      query.mockImplementationOnce(async (sql: string, params?: unknown[]) => { await gate; return base(sql, params); });

      const first = worker.poll();
      await worker.poll(); // overlapping cron tick
      expect(query).toHaveBeenCalledTimes(1);
      release();
      await first;
      const callsAfterFirst = query.mock.calls.length;
      await worker.poll();
      expect(query.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('releases the running flag even when the stale sweep itself throws', async () => {
      const { worker, query } = setup();
      query.mockRejectedValueOnce(new Error('db down'));
      await expect(worker.poll()).rejects.toThrow('db down');
      expect(worker['polling'].isRunning).toBe(false);
    });
  });

  describe('shutdown drain and per-job deadline', () => {
    it('beforeApplicationShutdown waits for the in-flight job, then releases the untouched rest of the batch to PENDING without running it', async () => {
      const t = Date.now();
      const { worker, chain, firstParams, stmts } = setup({
        claimed: [{ id: 'a', scheduled_at: new Date(t - 3000) }, { id: 'b', scheduled_at: new Date(t - 2000) }, { id: 'c', scheduled_at: new Date(t - 1000) }],
      });
      jest.spyOn(worker['logger'], 'log').mockImplementation(() => undefined);
      let finishMint!: (hash: string) => void;
      chain.mint.mockImplementationOnce(() => new Promise<string>((resolve) => { finishMint = resolve; }));

      const poll = worker.poll();
      await waitUntil(() => chain.mint.mock.calls.length === 1);
      let drained = false;
      const shutdown = worker.beforeApplicationShutdown().then(() => { drained = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false); // still waiting on job a

      finishMint('0xlate');
      await Promise.all([poll, shutdown]);
      expect(firstParams(STMT.succeeded)).toEqual(['a']); // the in-flight job finished and was recorded
      expect(chain.mint).toHaveBeenCalledTimes(1); // b and c never ran
      expect(stmts(STMT.release).map(({ params }) => params)).toEqual([[['b', 'c'], ['claim:b', 'claim:c']]]);
    });

    it('a poll after shutdown claims nothing and touches no rows', async () => {
      const { worker, query } = setup();
      await worker.beforeApplicationShutdown();
      await worker.poll();
      expect(query).not.toHaveBeenCalled();
    });

    it('shutdown arriving during the stale sweep skips the claim', async () => {
      const { worker, query, ran } = setup();
      const base = query.getMockImplementation()!;
      let releaseSweep!: () => void;
      const gate = new Promise<void>((resolve) => { releaseSweep = resolve; });
      query.mockImplementationOnce(async (sql: string, params?: unknown[]) => { await gate; return base(sql, params); });
      const poll = worker.poll();
      const shutdown = worker.beforeApplicationShutdown();
      releaseSweep();
      await Promise.all([poll, shutdown]);
      expect(ran(STMT.claim)).toBe(false);
    });

    it('a release failure during shutdown is logged, not thrown (the 15-minute stale requeue is the fallback)', async () => {
      const { worker, mock, chain } = setup({ claimed: [{ id: 'a', scheduled_at: new Date(1) }, { id: 'b', scheduled_at: new Date(2) }] });
      mock.handle(STMT.release, () => { throw new Error('pool gone'); });
      const error = jest.spyOn(worker['logger'], 'error').mockImplementation(() => undefined);
      let finishMint!: (hash: string) => void;
      chain.mint.mockImplementationOnce(() => new Promise<string>((resolve) => { finishMint = resolve; }));
      const poll = worker.poll();
      await waitUntil(() => chain.mint.mock.calls.length === 1);
      const shutdown = worker.beforeApplicationShutdown();
      finishMint('0x');
      await expect(Promise.all([poll, shutdown])).resolves.toBeDefined();
      expect(error).toHaveBeenCalledWith('shutdown: could not release unstarted nft_job(s): pool gone');
    });

    it('a job whose chain call hangs past the deadline is recorded as an ordinary retryable failure and the batch moves on', async () => {
      const { worker, chain, failureRecorded, firstParams } = setup({ claimed: [{ id: 'hung', scheduled_at: new Date(1) }, { id: 'next', scheduled_at: new Date(2) }] });
      (worker as unknown as { executionDeadlineMs: number }).executionDeadlineMs = 20;
      chain.mint.mockImplementationOnce(() => new Promise<string>(() => undefined)); // never settles
      await worker.poll();
      expect(failureRecorded()).toEqual([['hung', 'PENDING', 'nft_job execution timed out after 0.02s (chain call hung?)']]);
      expect(firstParams(STMT.succeeded)).toEqual(['next']);
      expect(worker['polling'].isRunning).toBe(false);
    });

    it('the execution deadline stays well under the 15-minute stale-requeue interval', () => {
      expect(JOB_EXECUTION_DEADLINE_MS).toBe(3 * 60_000);
    });
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!condition()) throw new Error('condition not reached');
}
