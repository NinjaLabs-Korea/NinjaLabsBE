import { computeAddress, Wallet } from 'ethers';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { AgentsService } from './agents.service';

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

  function createService() {
    const db = {
      query: jest.fn(),
      tx: jest.fn(),
    };
    const service = new TestAgentsService(
      db as unknown as DatabaseService,
      new AuditService(db as unknown as DatabaseService),
    );
    return { db, service };
  }

  type OccupiedRow = { id: string; owner_user_id: string; status?: string; abandoned?: boolean };

  /** register() tx: occupied-row lookup (REVOKED / PENDING on the same wallet or key) → INSERT. `revoked` rows are what the FOR UPDATE lookup returns. */
  function registerTxQuery(options: { revoked?: OccupiedRow[]; insert?: unknown } = {}) {
    return jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("status IN ('REVOKED', 'PENDING_VERIFICATION') AND deleted_at IS NULL")) {
        const rows = (options.revoked ?? []).map((row) => ({ status: 'REVOKED', abandoned: false, ...row }));
        return { rowCount: rows.length, rows };
      }
      if (sql.includes('INSERT INTO agent (')) {
        if (options.insert instanceof Error || (options.insert as { code?: string })?.code) throw options.insert;
        return { rowCount: 1, rows: [{ id: agentId }] };
      }
      return { rowCount: 1, rows: [] };
    });
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
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ expires_at: '2026-12-01T00:00:00.000Z' }],
      });
    db.tx
      .mockImplementationOnce(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
        callback({ query: registerQuery }))
      .mockImplementationOnce(async (callback: (tx: { query: typeof verifyQuery }) => Promise<unknown>) =>
        callback({ query: verifyQuery }));

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
    const recoveredPublicKey = verifyQuery.mock.calls[1][1][1] as string;
    expect(computeAddress(recoveredPublicKey)).toBe(signer.address);
  });

  it('returns the existing pending challenge after a rejected signature retry', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery({ insert: { code: '23505' } });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: agentId }] });

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).resolves.toEqual({
      agentId,
      status: 'PENDING_VERIFICATION',
      verificationMessage: AgentsService.verificationMessage(agentId, ownerUserId),
    });
    expect(db.query.mock.calls[0][0]).toContain("status = 'PENDING_VERIFICATION'");
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
    expect(registerQuery).toHaveBeenCalledTimes(2);
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
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    const registerQuery = registerTxQuery({
      revoked: [{ id: agentId, owner_user_id: ownerUserId, status: 'PENDING_VERIFICATION', abandoned: true }],
      insert: { code: '23505' },
    });
    db.tx.mockImplementation(async (callback: (tx: { query: typeof registerQuery }) => Promise<unknown>) =>
      callback({ query: registerQuery }));
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: agentId }] });

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
    await service.register(ownerUserId, 'inj-agent', undefined, 'AgentPubKeyBase64', 'inj1agentwallet');
    // $2 is cast identically in both positions — a bare + cast mix is a 42P08 at parse time on a real Postgres
    expect(registerQuery.mock.calls[0][0]).toContain('($2::text IS NOT NULL AND public_key = $2::text)');
    expect(registerQuery.mock.calls[0][1]).toEqual(['inj1agentwallet', 'AgentPubKeyBase64']);
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
        callback({ query: txQuery }),
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
    const txQuery = jest.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        if (selects++ > 0) await firstCommitted;
        return { rowCount: 1, rows: [{ status, public_key: null, wallet_address: signer.address }] };
      }
      if (sql.includes('UPDATE agent')) { status = 'ACTIVE'; return { rowCount: 1, rows: [] }; }
      if (sql.includes('INSERT INTO agent_api_key')) {
        return { rowCount: 1, rows: [{ expires_at: '2026-12-01T00:00:00.000Z' }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
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
  });
});

describe('AgentsService key rotation and revocation', () => {
  const agentId = '11111111-1111-4111-8111-111111111111';
  const ownerUserId = '22222222-2222-4222-8222-222222222222';

  function setup(status: string | null) {
    const txQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return { rowCount: status ? 1 : 0, rows: status ? [{ status }] : [] };
      }
      if (sql.includes('INSERT INTO agent_api_key')) {
        return { rowCount: 1, rows: [{ expires_at: '2027-01-20T00:00:00.000Z' }] };
      }
      return { rowCount: 1, rows: [] };
    });
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
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: agentId, key_status: 'EXPIRED', key_expires_at: '2020-01-01T00:00:00.000Z' }] });
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
