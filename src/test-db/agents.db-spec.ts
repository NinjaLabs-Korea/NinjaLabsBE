import { HDNodeWallet, Wallet } from 'ethers';
import { AgentApiKeyService } from '../agents/agent-api-key.service';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser } from './harness';

// Only the ADR-36 verifier reaches @injectivelabs/sdk-ts (ESM-only); the EVM path signs with a real ethers wallet.
jest.mock('@injectivelabs/sdk-ts', () => ({}));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describeDb('agent lifecycle on a real database', () => {
  let db: DatabaseService;
  let agents: AgentsService;
  let keys: AgentApiKeyService;

  beforeAll(() => {
    db = createDb();
    agents = new AgentsService(db, new AuditService(db));
    keys = new AgentApiKeyService(db);
  });
  afterAll(async () => db.onModuleDestroy());

  async function agentRow(id: string) {
    const r = await db.query<{ status: string; deleted_at: Date | null; public_key: string | null; wallet_address: string; verified_at: Date | null }>(
      `SELECT status, deleted_at, public_key, wallet_address, verified_at FROM agent WHERE id = $1`, [id]);
    return r.rows[0];
  }

  async function registerAndVerify(ownerId: string, signer: HDNodeWallet, name = 'bot') {
    const registered = await agents.register(ownerId, name, undefined, undefined, signer.address);
    expect(registered.status).toBe('PENDING_VERIFICATION');
    const signature = await signer.signMessage(registered.verificationMessage);
    const verified = await agents.verifyAndIssueKey(ownerId, registered.agentId, signature);
    expect(verified).toMatchObject({ agentId: registered.agentId, status: 'ACTIVE' });
    return { agentId: registered.agentId, apiKey: verified.apiKey };
  }

  it('register → verify → rotate → revoke → re-register the same wallet keeps the revoked agent and its history', async () => {
    const ownerId = await createUser(db);
    const signer = Wallet.createRandom();
    const { agentId, apiKey } = await registerAndVerify(ownerId, signer);
    expect(await agentRow(agentId)).toMatchObject({ status: 'ACTIVE', deleted_at: null, wallet_address: signer.address });
    expect((await agentRow(agentId)).public_key).toMatch(/^0x0[23][0-9a-f]{64}$/);
    await expect(keys.authenticate(apiKey)).resolves.toMatchObject({ agentId, ownerUserId: ownerId, name: 'bot' });
    // verifying twice is refused
    await expect(agents.verifyAndIssueKey(ownerId, agentId, '0x00')).rejects.toMatchObject({ message: 'AGENT_ALREADY_VERIFIED' });

    const rotated = await agents.rotateKey(ownerId, agentId);
    expect(rotated.apiKey).not.toBe(apiKey);
    await expect(keys.authenticate(apiKey)).rejects.toMatchObject({ message: 'INVALID_AGENT_API_KEY' });
    await expect(keys.authenticate(rotated.apiKey)).resolves.toMatchObject({ agentId });
    const activeKeys = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent_api_key WHERE agent_id = $1 AND status = 'ACTIVE'`, [agentId]);
    expect(activeKeys.rows[0].n).toBe(1);

    await expect(agents.revoke(ownerId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
    await expect(agents.revoke(ownerId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' }); // idempotent
    await expect(keys.authenticate(rotated.apiKey)).rejects.toMatchObject({ message: 'INVALID_AGENT_API_KEY' });
    await expect(agents.rotateKey(ownerId, agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_ACTIVE' });
    expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_KEY_ROTATED', 'AGENT_REVOKED']);

    // re-register the same wallet: a NEW row; the REVOKED one is neither deleted nor hidden
    const again = await registerAndVerify(ownerId, signer, 'bot-v2');
    expect(again.agentId).not.toBe(agentId);
    expect(await agentRow(agentId)).toMatchObject({ status: 'REVOKED', deleted_at: null });
    expect(await agentRow(again.agentId)).toMatchObject({ status: 'ACTIVE', deleted_at: null, wallet_address: signer.address });
    // both rows carry the same recovered public key — uq_agent_public_key ignores REVOKED rows too
    expect((await agentRow(again.agentId)).public_key).toBe((await agentRow(agentId)).public_key);

    const mine = await agents.myAgents(ownerId);
    expect(mine.map((agent: { id: string; status: string; key_status: string | null }) => [agent.id, agent.status, agent.key_status]))
      .toEqual([[agentId, 'REVOKED', 'REVOKED'], [again.agentId, 'ACTIVE', 'ACTIVE']]);
    await expect(keys.authenticate(again.apiKey)).resolves.toMatchObject({ agentId: again.agentId });
  });

  it('a wallet held by another owner (REVOKED, ACTIVE or fresh PENDING) stays 409; an abandoned PENDING squat (>24h) is taken over', async () => {
    const owner = await createUser(db);
    const other = await createUser(db);
    const signer = Wallet.createRandom();

    const { agentId } = await registerAndVerify(owner, signer);
    await expect(agents.register(other, 'thief', undefined, undefined, signer.address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    await agents.revoke(owner, agentId);
    await expect(agents.register(other, 'thief', undefined, undefined, signer.address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });

    // a fresh PENDING row of another user blocks; once it is older than 24h it is soft-deleted and the wallet is free
    const squatter = await createUser(db);
    const squat = Wallet.createRandom();
    const pending = await agents.register(squatter, 'squat', undefined, undefined, squat.address);
    await expect(agents.register(other, 'late', undefined, undefined, squat.address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
    await db.query(`UPDATE agent SET created_at = now() - interval '25 hours' WHERE id = $1`, [pending.agentId]);
    const takeover = await agents.register(other, 'late', undefined, undefined, squat.address);
    expect(takeover.agentId).not.toBe(pending.agentId);
    expect((await agentRow(pending.agentId)).deleted_at).toBeInstanceOf(Date);
    // the squatter's own re-register now returns their soft-deleted row no more: it is blocked by the live PENDING row
    await expect(agents.register(squatter, 'squat', undefined, undefined, squat.address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
  });

  it("registering again while my own PENDING row exists returns that row; someone else's agent id is 404 for verify/rotate/revoke", async () => {
    const owner = await createUser(db);
    const stranger = await createUser(db);
    const signer = Wallet.createRandom();
    const first = await agents.register(owner, 'bot', undefined, undefined, signer.address);
    const second = await agents.register(owner, 'bot-renamed', undefined, undefined, signer.address);
    expect(second).toEqual({ agentId: first.agentId, status: 'PENDING_VERIFICATION', verificationMessage: first.verificationMessage });
    await expect(agents.verifyAndIssueKey(stranger, first.agentId, '0x00')).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    await expect(agents.rotateKey(stranger, first.agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    await expect(agents.revoke(stranger, first.agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    // a signature from a different key is rejected and leaves the row pending
    await expect(agents.verifyAndIssueKey(owner, first.agentId, await Wallet.createRandom().signMessage(first.verificationMessage)))
      .rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(await agentRow(first.agentId)).toMatchObject({ status: 'PENDING_VERIFICATION', public_key: null });
  });
});
