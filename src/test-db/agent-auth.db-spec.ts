import { Wallet } from 'ethers';
import { agentApiKeyPrefix, hashAgentApiKey } from '../agents/agent-api-key';
import { AgentApiKeyService } from '../agents/agent-api-key.service';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { createDb, createUser } from './harness';

// sdk-ts is ESM-only: the e2e stub gives the real inj1 <-> 0x helpers (register compares the agent wallet with the owner's)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

/**
 * Agent API key authentication against real rows — the owner/agent/key predicates live in SQL (JOIN "user", key_prefix lookup,
 * conditional last_used_at UPDATE), so a mock DB cannot tell whether a suspended owner or an expired key is actually refused.
 */
describeDb('agent API key authentication on a real database', () => {
  let db: DatabaseService;
  let agents: AgentsService;
  let keys: AgentApiKeyService;

  beforeAll(() => {
    db = createDb();
    agents = new AgentsService(db, new AuditService(db));
    keys = new AgentApiKeyService(db);
  });
  afterAll(async () => db.onApplicationShutdown());

  async function activeAgent() {
    const ownerId = await createUser(db);
    const signer = Wallet.createRandom();
    const registered = await agents.register(ownerId, 'auth-bot', undefined, undefined, signer.address);
    const verified = await agents.verifyAndIssueKey(ownerId, registered.agentId, await signer.signMessage(registered.verificationMessage));
    return { ownerId, agentId: registered.agentId, apiKey: verified.apiKey };
  }

  const rejected = { message: 'INVALID_AGENT_API_KEY' };

  async function keyRow(agentId: string) {
    const r = await db.query<{ key_prefix: string; key_hash: string; last_used_at: Date | null; expires_at: Date }>(
      `SELECT key_prefix, key_hash, last_used_at, expires_at FROM agent_api_key WHERE agent_id = $1 AND status = 'ACTIVE'`, [agentId]);
    return r.rows[0];
  }

  it('stores only the lookup prefix and sha256 (never the raw key), expires in 90 days, and stamps last_used_at on each successful auth', async () => {
    const { agentId, apiKey, ownerId } = await activeAgent();
    const before = await keyRow(agentId);
    expect(before.key_prefix).toBe(agentApiKeyPrefix(apiKey));
    expect(before.key_hash).toBe(hashAgentApiKey(apiKey));
    expect(before.last_used_at).toBeNull();
    const days = (before.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    const raw = await db.query(`SELECT 1 FROM agent_api_key WHERE key_hash = $1 OR key_prefix = $1`, [apiKey]);
    expect(raw.rowCount).toBe(0);

    await expect(keys.authenticate(apiKey)).resolves.toMatchObject({ agentId, ownerUserId: ownerId, name: 'auth-bot' });
    expect((await keyRow(agentId)).last_used_at).toBeInstanceOf(Date);
  });

  it('an expired key is refused, and myAgents reports it as EXPIRED', async () => {
    const { agentId, apiKey, ownerId } = await activeAgent();
    await db.query(`UPDATE agent_api_key SET expires_at = now() - interval '1 second' WHERE agent_id = $1`, [agentId]);
    await expect(keys.authenticate(apiKey)).rejects.toMatchObject(rejected);
    const mine = await agents.myAgents(ownerId);
    expect(mine).toEqual([expect.objectContaining({ id: agentId, status: 'ACTIVE', key_status: 'EXPIRED' })]);
    // a rotate recovers the agent with a fresh key
    const rotated = await agents.rotateKey(ownerId, agentId);
    await expect(keys.authenticate(rotated.apiKey)).resolves.toMatchObject({ agentId });
  });

  it.each(['SUSPENDED', 'WITHDRAWN'])('a %s owner\'s agent keys stop working immediately and work again once the owner is ACTIVE (keys are not revoked)', async (status) => {
    const { ownerId, agentId, apiKey } = await activeAgent();
    await db.query(`UPDATE "user" SET status = $2 WHERE id = $1`, [ownerId, status]);
    await expect(keys.authenticate(apiKey)).rejects.toMatchObject(rejected);
    const stillActive = await db.query(`SELECT 1 FROM agent_api_key WHERE agent_id = $1 AND status = 'ACTIVE'`, [agentId]);
    expect(stillActive.rowCount).toBe(1);

    await db.query(`UPDATE "user" SET status = 'ACTIVE' WHERE id = $1`, [ownerId]);
    await expect(keys.authenticate(apiKey)).resolves.toMatchObject({ agentId });
  });

  it('a soft-deleted owner, a soft-deleted agent and a SUSPENDED agent are all refused', async () => {
    const deletedOwner = await activeAgent();
    await db.query(`UPDATE "user" SET deleted_at = now() WHERE id = $1`, [deletedOwner.ownerId]);
    await expect(keys.authenticate(deletedOwner.apiKey)).rejects.toMatchObject(rejected);

    const deletedAgent = await activeAgent();
    await db.query(`UPDATE agent SET deleted_at = now() WHERE id = $1`, [deletedAgent.agentId]);
    await expect(keys.authenticate(deletedAgent.apiKey)).rejects.toMatchObject(rejected);

    const suspendedAgent = await activeAgent();
    await db.query(`UPDATE agent SET status = 'SUSPENDED' WHERE id = $1`, [suspendedAgent.agentId]);
    await expect(keys.authenticate(suspendedAgent.apiKey)).rejects.toMatchObject(rejected);
  });

  it('two keys sharing a lookup prefix each authenticate as their own agent; a key with that prefix but an unknown hash is refused', async () => {
    const a = await activeAgent();
    const b = await activeAgent();
    // prefixes are only 8 random chars after nj_ — collisions are expected at scale. Give b a key that starts with a's prefix.
    const prefix = agentApiKeyPrefix(a.apiKey);
    const colliding = `${prefix}${'C'.repeat(a.apiKey.length - prefix.length)}`;
    await db.query(`UPDATE agent_api_key SET key_prefix = $2, key_hash = $3 WHERE agent_id = $1`, [b.agentId, prefix, hashAgentApiKey(colliding)]);

    await expect(keys.authenticate(a.apiKey)).resolves.toMatchObject({ agentId: a.agentId });
    await expect(keys.authenticate(colliding)).resolves.toMatchObject({ agentId: b.agentId, ownerUserId: b.ownerId });
    await expect(keys.authenticate(`${prefix}${'x'.repeat(a.apiKey.length - prefix.length)}`)).rejects.toMatchObject(rejected);
  });

  it('after revoke, re-registering the same wallet issues a new key that works while the old key stays dead', async () => {
    const ownerId = await createUser(db);
    const signer = Wallet.createRandom();
    const first = await agents.register(ownerId, 'bot', undefined, undefined, signer.address);
    const firstKey = (await agents.verifyAndIssueKey(ownerId, first.agentId, await signer.signMessage(first.verificationMessage))).apiKey;
    await agents.revoke(ownerId, first.agentId);

    const second = await agents.register(ownerId, 'bot', undefined, undefined, signer.address);
    expect(second.agentId).not.toBe(first.agentId);
    const secondKey = (await agents.verifyAndIssueKey(ownerId, second.agentId, await signer.signMessage(second.verificationMessage))).apiKey;

    await expect(keys.authenticate(firstKey)).rejects.toMatchObject(rejected);
    await expect(keys.authenticate(secondKey)).resolves.toMatchObject({ agentId: second.agentId });
  });

  it('a pending (unverified) agent has no key and verifying it with a signature bound to another agent id is 401', async () => {
    const ownerId = await createUser(db);
    const signer = Wallet.createRandom();
    const pending = await agents.register(ownerId, 'bot', undefined, undefined, signer.address);
    const wrong = await signer.signMessage(AgentsService.verificationMessage('00000000-0000-4000-8000-000000000000', ownerId));
    await expect(agents.verifyAndIssueKey(ownerId, pending.agentId, wrong)).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    const status = await db.query<{ status: string }>(`SELECT status FROM agent WHERE id = $1`, [pending.agentId]);
    expect(status.rows[0].status).toBe('PENDING_VERIFICATION');
    const issued = await db.query(`SELECT 1 FROM agent_api_key WHERE agent_id = $1`, [pending.agentId]);
    expect(issued.rowCount).toBe(0);
  });
});
