import { ConflictException } from '@nestjs/common';
import { computeAddress, Wallet } from 'ethers';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { withParamsCheck } from '../test-support/expect-params-match';
import { AgentsService } from './agents.service';

// sdk-ts is ESM-only: the e2e stub implements the inj1 <-> 0x helpers with real bech32 (byte-identical to sdk-ts)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({
  verifyAdr36Signature: jest.fn(() => false),
}));

class TestAgentsService extends AgentsService {
  protected generateApiKey() {
    return { raw: 'nj_test_key', prefix: 'nj_test_key', hash: 'test-hash' };
  }
}

describe('AgentsService EVM registration', () => {
  const agentId = '11111111-1111-4111-8111-111111111111';
  const ownerUserId = '22222222-2222-4222-8222-222222222222';

  type PendingRow = { id: string; owner_user_id: string; wallet_address: string };

  /**
   * `db.query` (outside the tx) only ever serves the "my own PENDING row on this wallet" lookup after a unique violation. It answers from
   * `pending` by the predicates the statement actually carries: the wallet always, the owner only while `owner_user_id = $1` is present —
   * so dropping the owner predicate hands back someone else's pending row and the 409 cases below fail.
   */
  function createService(pending: PendingRow[] = []) {
    const db = {
      query: jest.fn(withParamsCheck(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM agent') && sql.includes("status = 'PENDING_VERIFICATION' AND deleted_at IS NULL")) {
          const byOwner = sql.includes('owner_user_id = $1 AND wallet_address = $2');
          const rows = pending.filter((row) => params!.includes(row.wallet_address) && (!byOwner || params![0] === row.owner_user_id));
          return { rowCount: rows.length, rows: rows.map(({ id }) => ({ id })) };
        }
        throw new Error(`Unexpected query outside the transaction: ${sql}`);
      })),
      tx: jest.fn(),
    };
    const service = new TestAgentsService(
      db as unknown as DatabaseService,
      new AuditService(db as unknown as DatabaseService),
    );
    return { db, service };
  }

  type OccupiedRow = { id: string; owner_user_id: string; status?: string; verified?: boolean; abandoned?: boolean };

  /** register() tx: occupied-row lookup (REVOKED / PENDING on the same wallet or key) → INSERT. `revoked` rows are what the FOR UPDATE lookup returns. */
  function registerTxQuery(options: { revoked?: OccupiedRow[]; insert?: unknown; onboarded?: boolean } = {}) {
    return jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("status IN ('REVOKED', 'PENDING_VERIFICATION') AND deleted_at IS NULL")) {
        const rows = (options.revoked ?? []).map((row) => ({ status: 'REVOKED', verified: true, abandoned: false, ...row }));
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('INSERT INTO agent (')) {
        if (options.insert instanceof Error || (options.insert as { code?: string })?.code) throw options.insert;
        return { rowCount: 1, rows: [{ id: agentId }] };
      }
      if (sql.includes('onboarding_completed_at IS NOT NULL AS done')) return { rowCount: 1, rows: [{ done: options.onboarded ?? true }] };
      return { rowCount: 1, rows: [] };
    }));
  }

  it('registers a dedicated 0x wallet without a public key, then recovers it on verify', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery();
    const verifyQuery = jest
      .fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            status: 'PENDING_VERIFICATION',
            public_key: null,
            wallet_address: signer.address,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // clear the recovered key off other EVM PENDING rows (legacy client keys)
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ expires_at: '2026-12-01T00:00:00.000Z' }],
      });
    db.tx
      .mockImplementationOnce(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
        callback({ query: registerQuery }))
      .mockImplementationOnce(async (callback: (tx: { query: typeof verifyQuery }) => Promise<unknown>) =>
        callback({ query: withParamsCheck(verifyQuery) }));

    const registration = await service.register(
      ownerUserId,
      'market-agent',
      undefined,
      undefined,
      signer.address.toLowerCase(),
    );
    expect(registration).toMatchObject({
      agentId,
      status: 'PENDING_VERIFICATION',
    });
    expect(db.query).not.toHaveBeenCalled();
    const insert = registerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent ('))!;
    expect(insert[1]).toEqual([
      ownerUserId,
      'market-agent',
      null,
      null,
      signer.address,
    ]);

    const signature = await signer.signMessage(registration.verificationMessage);
    const verified = await service.verifyAndIssueKey(ownerUserId, agentId, signature);

    expect(verified).toEqual({
      agentId,
      status: 'ACTIVE',
      apiKey: 'nj_test_key',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    expect(verifyQuery.mock.calls[0][0]).toContain('FOR UPDATE');
    const recoveredPublicKey = verifyQuery.mock.calls[2][1][1] as string;
    expect(verifyQuery.mock.calls[2][0]).toContain("SET status = 'ACTIVE'");
    expect(computeAddress(recoveredPublicKey)).toBe(signer.address);
    expect(verifyQuery.mock.calls[1][0]).toContain('UPDATE agent SET public_key = NULL');
    expect(verifyQuery.mock.calls[1][1]).toEqual([recoveredPublicKey, agentId]);
    // the first key issuance is audited inside the same tx, after the key insert
    expect(verifyQuery.mock.calls[4][0]).toContain('INSERT INTO audit_log');
    expect(verifyQuery.mock.calls[4][1]).toEqual([ownerUserId, 'AGENT_VERIFIED', 'agent', agentId]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns the existing pending challenge after a rejected signature retry — looked up by (owner, wallet) outside the rolled-back tx', async () => {
    const signer = Wallet.createRandom();
    const { db, service } = createService([{ id: agentId, owner_user_id: ownerUserId, wallet_address: signer.address }]);
    const registerQuery = registerTxQuery({ insert: { code: '23505' } });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).resolves.toEqual({
      agentId,
      status: 'PENDING_VERIFICATION',
      verificationMessage: AgentsService.verificationMessage(agentId, ownerUserId),
    });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("status = 'PENDING_VERIFICATION' AND deleted_at IS NULL");
    // scoped to the caller: a pending row of another owner on the same wallet must not be handed out as "yours"
    expect(sql).toContain('WHERE owner_user_id = $1 AND wallet_address = $2');
    expect(params).toEqual([ownerUserId, signer.address]);
  });

  it.each([
    ['no pending row at all', () => [] as PendingRow[]],
    ["another owner's pending row on the same wallet", (wallet: string) => [
      { id: '66666666-6666-4666-8666-666666666666', owner_user_id: '44444444-4444-4444-8444-444444444444', wallet_address: wallet },
    ]],
    ["the caller's own pending row on a different wallet", () => [
      { id: agentId, owner_user_id: ownerUserId, wallet_address: '0x0000000000000000000000000000000000000001' },
    ]],
  ])('keeps the 409 after a unique violation when there is %s (the pending lookup is scoped to owner AND wallet)', async (_label, pending) => {
    const signer = Wallet.createRandom();
    const { db, service } = createService(pending(signer.address));
    const registerQuery = registerTxQuery({ insert: { code: '23505' } });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    const error = await service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).message).toBe('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual([ownerUserId, signer.address]);
  });

  it("keeps the caller's own REVOKED agent on the same wallet (no soft delete — its history stays visible) and registers a new one", async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const oldId = '33333333-3333-4333-8333-333333333333';
    const registerQuery = registerTxQuery({ revoked: [{ id: oldId, owner_user_id: ownerUserId }] });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent-v2', undefined, undefined, signer.address),
    ).resolves.toMatchObject({ agentId, status: 'PENDING_VERIFICATION' });

    // lookup (FOR UPDATE) → INSERT; uq_agent_wallet ignores REVOKED rows (0014), so nothing is retired
    const [lookup, insert] = registerQuery.mock.calls;
    expect(registerQuery).toHaveBeenCalledTimes(4); // + the owner-wallet check and the owner onboarding check after the INSERT
    expect(lookup[0]).toContain("status IN ('REVOKED', 'PENDING_VERIFICATION') AND deleted_at IS NULL");
    expect(lookup[0]).toContain('FOR UPDATE');
    expect(lookup[1]).toEqual([signer.address, null]);
    expect(insert[0]).toContain('INSERT INTO agent (');
    expect(registerQuery.mock.calls.some(([sql]) => sql.includes('SET deleted_at = now()'))).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('keeps the 409 when the REVOKED agent on that wallet belongs to someone else, without soft-deleting or inserting', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery({
      revoked: [{ id: '33333333-3333-4333-8333-333333333333', owner_user_id: '44444444-4444-4444-8444-444444444444' }],
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    expect(registerQuery).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('an owner who has not finished onboarding cannot register an agent (409 PROFILE_REQUIRED, the transaction is rolled back)', async () => {
    const { db, service } = createService();
    const registerQuery = registerTxQuery({ onboarded: false });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, Wallet.createRandom().address))
      .rejects.toMatchObject({ status: 409, message: 'PROFILE_REQUIRED' });
  });

  it("does not let another owner's never-verified REVOKED agent (a PENDING squat revoked on the spot) block the wallet", async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery({
      revoked: [{ id: '33333333-3333-4333-8333-333333333333', owner_user_id: '44444444-4444-4444-8444-444444444444', verified: false }],
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address)).resolves.toMatchObject({ agentId });
    expect(registerQuery.mock.calls.some(([sql]) => sql.includes('SET deleted_at = now()'))).toBe(false); // the revoked row is left as is
    expect(registerQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent ('))).toBe(true);
  });

  it("soft-deletes another owner's PENDING_VERIFICATION agent older than 24h (abandoned squat) and proceeds", async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const squatId = '55555555-5555-4555-8555-555555555555';
    const registerQuery = registerTxQuery({
      revoked: [{ id: squatId, owner_user_id: '44444444-4444-4444-8444-444444444444', status: 'PENDING_VERIFICATION', abandoned: true }],
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).resolves.toMatchObject({ agentId, status: 'PENDING_VERIFICATION' });

    const [lookup, retire, insert] = registerQuery.mock.calls;
    // Abandonment is decided in SQL under the row lock, from created_at.
    expect(lookup[0]).toContain("created_at < now() - interval '24 hours'");
    expect(lookup[0]).toContain('FOR UPDATE');
    expect(retire[0]).toContain('UPDATE agent SET deleted_at = now() WHERE id = ANY($1::uuid[])');
    expect(retire[1]).toEqual([[squatId]]);
    expect(insert[0]).toContain('INSERT INTO agent (');
    expect(db.query).not.toHaveBeenCalled();
  });

  it("keeps the 409 for another owner's PENDING_VERIFICATION agent younger than 24h, without soft-deleting or inserting", async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery({
      revoked: [{ id: '55555555-5555-4555-8555-555555555555', owner_user_id: '44444444-4444-4444-8444-444444444444', status: 'PENDING_VERIFICATION', abandoned: false }],
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    expect(registerQuery).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("leaves the caller's own PENDING_VERIFICATION row alone (the INSERT conflict returns it)", async () => {
    const signer = Wallet.createRandom();
    const { db, service } = createService([{ id: agentId, owner_user_id: ownerUserId, wallet_address: signer.address }]);
    const registerQuery = registerTxQuery({
      revoked: [{ id: agentId, owner_user_id: ownerUserId, status: 'PENDING_VERIFICATION', abandoned: true }],
      insert: { code: '23505' },
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).resolves.toMatchObject({ agentId, status: 'PENDING_VERIFICATION' });
    expect(registerQuery.mock.calls.some(([sql]) => sql.includes('SET deleted_at = now()'))).toBe(false);
  });

  it('matches a revoked agent by public key too for inj1 registrations', async () => {
    const { db, service } = createService();
    const registerQuery = registerTxQuery();
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));
    const injSigner = Wallet.createRandom();
    const injAddress = getInjectiveAddress(injSigner.address);
    const publicKey = Buffer.from(injSigner.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64');
    await service.register(ownerUserId, 'inj-agent', undefined, publicKey, injAddress);
    // $2 is cast identically in both positions — a bare + cast mix is a 42P08 at parse time on a real Postgres
    expect(registerQuery.mock.calls[0][0]).toContain('($2::text IS NOT NULL AND public_key = $2::text)');
    expect(registerQuery.mock.calls[0][1]).toEqual([injAddress, publicKey]);
  });

  it('rejects a signature from a different EVM key', async () => {
    const { db, service } = createService();
    const registered = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const txQuery = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          status: 'PENDING_VERIFICATION',
          public_key: null,
          wallet_address: registered.address,
        },
      ],
    });
    db.tx.mockImplementation(
      async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
        callback({ query: withParamsCheck(txQuery) }),
    );
    const signature = await attacker.signMessage(
      AgentsService.verificationMessage(agentId, ownerUserId),
    );

    await expect(service.verifyAndIssueKey(ownerUserId, agentId, signature)).rejects.toMatchObject({
      message: 'INVALID_SIGNATURE',
    });
    // Only the locking SELECT ran — no ACTIVE transition and no key insert.
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('issues exactly one key when the same agent is verified twice concurrently', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const signature = await signer.signMessage(
      AgentsService.verificationMessage(agentId, ownerUserId),
    );
    // Simulate the row lock: the second SELECT ... FOR UPDATE only resolves after the
    // first transaction has committed, and then observes status = ACTIVE.
    let status = 'PENDING_VERIFICATION';
    let release: (() => void) | undefined;
    const firstCommitted = new Promise<void>((resolve) => { release = resolve; });
    let selects = 0;
    const txQuery = jest.fn(withParamsCheck(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        if (selects++ > 0) await firstCommitted;
        return { rowCount: 1, rows: [{ status, public_key: null, wallet_address: signer.address }] };
      }
      if (sql.includes('UPDATE agent')) { status = 'ACTIVE'; return { rowCount: 1, rows: [] }; }
      if (sql.includes('INSERT INTO agent_api_key')) {
        return { rowCount: 1, rows: [{ expires_at: '2026-12-01T00:00:00.000Z' }] };
      }
      if (sql.includes('INSERT INTO audit_log')) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }));
    db.tx.mockImplementation(
      async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) => {
        try {
          return await callback({ query: txQuery });
        } finally {
          release?.();
        }
      },
    );

    const results = await Promise.allSettled([
      service.verifyAndIssueKey(ownerUserId, agentId, signature),
      service.verifyAndIssueKey(ownerUserId, agentId, signature),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ message: 'AGENT_ALREADY_VERIFIED' });
    expect(txQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO agent_api_key'))).toHaveLength(1);
    expect(txQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO audit_log'))).toHaveLength(1);
  });
});

describe('AgentsService key rotation and revocation', () => {
  const agentId = '11111111-1111-4111-8111-111111111111';
  const ownerUserId = '22222222-2222-4222-8222-222222222222';

  function setup(status: string | null) {
    const txQuery = jest.fn(withParamsCheck(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: status ? 1 : 0, rows: status ? [{ status }] : [] };
      }
      if (sql.includes('INSERT INTO agent_api_key')) {
        return { rowCount: 1, rows: [{ expires_at: '2027-01-20T00:00:00.000Z' }] };
      }
      return { rowCount: 1, rows: [] };
    }));
    const db = {
      query: jest.fn(),
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
        callback({ query: txQuery })),
    };
    const service = new TestAgentsService(
      db as unknown as DatabaseService,
      new AuditService(db as unknown as DatabaseService),
    );
    const sqls = () => txQuery.mock.calls.map(([sql]) => sql as string);
    return { db, service, txQuery, sqls };
  }

  it('rotates: locks the agent, revokes every ACTIVE key, inserts one key and audits in the same tx', async () => {
    const { db, service, txQuery, sqls } = setup('ACTIVE');
    await expect(service.rotateKey(ownerUserId, agentId)).resolves.toEqual({
      agentId, apiKey: 'nj_test_key', expiresAt: '2027-01-20T00:00:00.000Z',
    });
    expect(db.tx).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    const order = sqls();
    expect(order[0]).toContain('FOR UPDATE');
    expect(txQuery.mock.calls[0][1]).toEqual([agentId, ownerUserId]);
    expect(order[1]).toContain(`SET status = 'REVOKED', revoked_at = now()`);
    expect(order[1]).toContain(`WHERE agent_id = $1 AND status = 'ACTIVE'`);
    expect(order[2]).toContain('INSERT INTO agent_api_key');
    expect(order[2]).toContain("interval '90 days'");
    expect(txQuery.mock.calls[2][1]).toEqual([agentId, 'nj_test_key', 'test-hash']);
    expect(order[3]).toContain('INSERT INTO audit_log');
    expect(txQuery.mock.calls[3][1]).toEqual([ownerUserId, 'AGENT_KEY_ROTATED', 'agent', agentId]);
  });

  it.each([
    ['PENDING_VERIFICATION', 'AGENT_NOT_ACTIVE'],
    ['REVOKED', 'AGENT_NOT_ACTIVE'],
    [null, 'AGENT_NOT_FOUND'],
  ])('refuses to rotate when the agent status is %s', async (status, code) => {
    const { service, txQuery } = setup(status);
    await expect(service.rotateKey(ownerUserId, agentId)).rejects.toMatchObject({ message: code });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('revokes the agent and all of its ACTIVE keys, auditing inside the tx', async () => {
    const { service, txQuery, sqls } = setup('ACTIVE');
    await expect(service.revoke(ownerUserId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
    const order = sqls();
    expect(order[0]).toContain('FOR UPDATE');
    expect(order[1]).toContain(`UPDATE agent SET status = 'REVOKED'`);
    expect(order[2]).toContain(`UPDATE agent_api_key SET status = 'REVOKED', revoked_at = now()`);
    expect(order[3]).toContain('INSERT INTO audit_log');
    expect(txQuery.mock.calls[3][1]).toEqual([ownerUserId, 'AGENT_REVOKED', 'agent', agentId]);
  });

  it('is idempotent: revoking an already revoked agent changes nothing and returns the same body', async () => {
    const { service, txQuery } = setup('REVOKED');
    await expect(service.revoke(ownerUserId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects revoking an agent the caller does not own', async () => {
    const { service } = setup(null);
    await expect(service.revoke(ownerUserId, agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
  });

  it('lists each agent once (REVOKED agents included) with the latest key and a computed key_status, hiding only soft-deleted rows', async () => {
    const { db, service } = setup('ACTIVE');
    db.query.mockImplementationOnce(withParamsCheck(async () => ({ rowCount: 1, rows: [{ id: agentId, key_status: 'EXPIRED', key_expires_at: '2020-01-01T00:00:00.000Z' }] })));
    await expect(service.myAgents(ownerUserId)).resolves.toHaveLength(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(params).toEqual([ownerUserId]);
    expect(sql).toContain('WHERE a.owner_user_id = $1 AND a.deleted_at IS NULL');
    expect(sql).not.toMatch(/a\.status\s*(<>|!=)\s*'REVOKED'/);
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain("ORDER BY (status = 'ACTIVE') DESC, created_at DESC");
    expect(sql).toContain('LIMIT 1');
    expect(sql).toContain("WHEN k.status = 'ACTIVE' AND k.expires_at <= now() THEN 'EXPIRED'");
    expect(sql).toContain('k.expires_at AS key_expires_at');
    expect(sql).not.toMatch(/LEFT JOIN agent_api_key k ON/);
  });
});
