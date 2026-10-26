import { HDNodeWallet, Wallet } from 'ethers';
import { AgentApiKeyService } from '../agents/agent-api-key.service';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { DatabaseService } from '../common/database/database.service';
import { describeDb } from './describe-db';
import { auditActions, createDb, createUser } from './harness';

// @injectivelabs/sdk-ts is ESM-only: the e2e stub gives the real inj1 <-> 0x helpers (register's key/address check); the ADR-36
// verifier itself is mocked below, and the EVM path signs with a real ethers wallet.
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
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
  afterAll(async () => db.onApplicationShutdown());

  const keysAuth = (apiKey: string) => keys.authenticate(apiKey);

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
    // verified once, then revoked: "already verified" is true
    await expect(agents.verifyAndIssueKey(ownerId, agentId, await signer.signMessage(AgentsService.verificationMessage(agentId, ownerId)))).rejects.toMatchObject({ status: 409, message: 'AGENT_ALREADY_VERIFIED' });
    expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_VERIFIED', 'AGENT_KEY_ROTATED', 'AGENT_REVOKED']);

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

  it('verify on an agent revoked before it was ever verified is 409 AGENT_NOT_PENDING (it never got a key), and issues no key', async () => {
    const owner = await createUser(db);
    const signer = Wallet.createRandom();
    const registered = await agents.register(owner, 'never-verified', undefined, undefined, signer.address);
    await agents.revoke(owner, registered.agentId);
    const signature = await signer.signMessage(registered.verificationMessage);
    await expect(agents.verifyAndIssueKey(owner, registered.agentId, signature)).rejects.toMatchObject({ status: 409, message: 'AGENT_NOT_PENDING' });
    expect((await db.query(`SELECT 1 FROM agent_api_key WHERE agent_id = $1`, [registered.agentId])).rowCount).toBe(0);
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

  it('revoking a never-verified PENDING squat does not turn it into a permanent claim on the wallet', async () => {
    const squatter = await createUser(db);
    const victim = await createUser(db);
    const wallet = Wallet.createRandom();

    // anyone can PENDING-register an address they do not control (no signature at register) and revoke it right away
    const squat = await agents.register(squatter, 'squat', undefined, undefined, wallet.address);
    await agents.revoke(squatter, squat.agentId);
    expect(await agentRow(squat.agentId)).toMatchObject({ status: 'REVOKED', verified_at: null });

    // the real owner is not locked out, and proves ownership as usual
    const mine = await registerAndVerify(victim, wallet, 'real');
    expect(await agentRow(mine.agentId)).toMatchObject({ status: 'ACTIVE', wallet_address: wallet.address });
    expect(await agentRow(squat.agentId)).toMatchObject({ status: 'REVOKED', deleted_at: null }); // the squatter's row is left alone
    await expect(keysAuth(mine.apiKey)).resolves.toMatchObject({ agentId: mine.agentId });
  });

  it("registering again while my own PENDING row exists returns that row; someone else's agent id is 404 for verify/rotate/revoke", async () => {
    const owner = await createUser(db);
    const stranger = await createUser(db);
    const signer = Wallet.createRandom();
    const first = await agents.register(owner, 'bot', undefined, undefined, signer.address);
    const second = await agents.register(owner, 'bot-renamed', 'new description', undefined, signer.address);
    expect(second).toEqual({ agentId: first.agentId, status: 'PENDING_VERIFICATION', verificationMessage: first.verificationMessage });
    // the retyped name / description replace the first registration's values instead of being dropped silently
    expect((await db.query(`SELECT name, description FROM agent WHERE id = $1`, [first.agentId])).rows[0]).toEqual({ name: 'bot-renamed', description: 'new description' });
    await expect(agents.verifyAndIssueKey(stranger, first.agentId, '0x00')).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    await expect(agents.rotateKey(stranger, first.agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    await expect(agents.revoke(stranger, first.agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    // a signature from a different key is rejected and leaves the row pending
    await expect(agents.verifyAndIssueKey(owner, first.agentId, await Wallet.createRandom().signMessage(first.verificationMessage)))
      .rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
    expect(await agentRow(first.agentId)).toMatchObject({ status: 'PENDING_VERIFICATION', public_key: null });
  });

  it('myAgents completed_bounties counts approved work like the public profile does: not other statuses, not soft-deleted bounties', async () => {
    const ownerId = await createUser(db);
    const adminId = await createUser(db, { isAdmin: true });
    const { agentId } = await registerAndVerify(ownerId, Wallet.createRandom());
    const submit = async (title: string, status: string, deleted = false) => {
      const bountyId = (await db.query<{ id: string }>(
        `INSERT INTO bounty (created_by, sponsor_name, title, summary, description, requirements, evaluation_criteria, category, submission_deadline, deleted_at)
         VALUES ($1, 's', $2, 's', 'd', 'r', 'e', 'DEV', now() + interval '7 days', CASE WHEN $3::boolean THEN now() END) RETURNING id`,
        [adminId, title, deleted])).rows[0].id;
      await db.query(
        `INSERT INTO bounty_submission (bounty_id, agent_id, submission_url, description, status) VALUES ($1, $2, 'https://example.test/w', 'd', $3)`,
        [bountyId, agentId, status]);
    };
    await submit('approved', 'APPROVED');
    await submit('approved-but-deleted', 'APPROVED', true);
    await submit('rejected', 'REJECTED');
    const [mine] = await agents.myAgents(ownerId);
    expect(mine.completed_bounties).toBe(1);
  });
});
