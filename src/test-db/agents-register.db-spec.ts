import { Wallet } from 'ethers';
import { agentApiKeyPrefix, hashAgentApiKey } from '../agents/agent-api-key';
import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { DatabaseService } from '../common/database/database.service';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { describeDb } from './describe-db';
import { auditActions, createDb, createPrimaryWallet, createUser } from './harness';

// @injectivelabs/sdk-ts is ESM-only: the e2e stub gives the real inj1 <-> 0x helpers; the ADR-36 verifier is a switchable verdict
// (its own math is out of scope), the EVM path signs with a real ethers wallet.
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const adr36 = verifyAdr36Signature as jest.MockedFunction<typeof verifyAdr36Signature>;

/** A real Injective key pair: inj1 = bech32 of the EVM address, publicKey = compressed key in base64 (Keplr pub_key.value) */
const injKey = (signer = Wallet.createRandom()) => ({
  signer,
  address: getInjectiveAddress(signer.address),
  publicKey: Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64'),
});

/**
 * 에이전트 등록/검증/회전/폐기 규칙을 실 Postgres 행으로 단언한다 (agents.service.spec.ts, agents.service.register.spec.ts의 옛 SQL 해석 mock 대체).
 * 전체 수명 주기와 지갑 점유 시나리오는 agents.db-spec.ts, 키 인증은 agent-auth.db-spec.ts가 이미 다룬다.
 */
describeDb('agent registration, verification and key rules on a real database', () => {
  let db: DatabaseService;
  let agents: AgentsService;

  beforeAll(() => {
    db = createDb();
    agents = new AgentsService(db, new AuditService(db));
  });
  afterAll(async () => db.onApplicationShutdown());
  beforeEach(() => { adr36.mockReset().mockReturnValue(false); });

  type AgentRow = { owner_user_id: string; name: string; description: string | null; status: string; public_key: string | null; wallet_address: string; verified_at: Date | null; deleted_at: Date | null };
  const agentRow = async (id: string) =>
    (await db.query<AgentRow>(`SELECT owner_user_id, name, description, status, public_key, wallet_address, verified_at, deleted_at FROM agent WHERE id = $1`, [id])).rows[0];
  const keyRows = async (agentId: string) =>
    (await db.query<{ key_prefix: string; key_hash: string; status: string; expires_at: Date; revoked_at: Date | null }>(
      `SELECT key_prefix, key_hash, status, expires_at, revoked_at FROM agent_api_key WHERE agent_id = $1 ORDER BY created_at`, [agentId])).rows;
  const sign = (signer: Wallet | ReturnType<typeof Wallet.createRandom>, message: string) => signer.signMessage(message);
  const countAgents = async (ownerId: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM agent WHERE owner_user_id = $1`, [ownerId])).rows[0].n;

  describe('register', () => {
    it('an EVM wallet stores the checksummed address and NULL as public key, whatever key the client sends (the key comes from the signature at verify)', async () => {
      const ownerId = await createUser(db);
      const signer = Wallet.createRandom();
      const someoneElsesKey = Wallet.createRandom().signingKey.compressedPublicKey;
      const registered = await agents.register(ownerId, 'bot', 'desc', someoneElsesKey, `  ${signer.address.toLowerCase()} `);
      expect(registered).toEqual({ agentId: expect.any(String), status: 'PENDING_VERIFICATION', verificationMessage: AgentsService.verificationMessage(registered.agentId, ownerId) });
      expect(await agentRow(registered.agentId)).toMatchObject({ owner_user_id: ownerId, name: 'bot', description: 'desc', status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address, verified_at: null, deleted_at: null });
    });

    it('an inj1 wallet stores the address (an all-upper-case form is folded to lower case) and the canonical public key; a second owner cannot pre-claim that key', async () => {
      const { address, publicKey } = injKey();
      const ownerId = await createUser(db);
      const registered = await agents.register(ownerId, 'inj-bot', undefined, publicKey, `  ${address.toUpperCase()}  `);
      const row = await agentRow(registered.agentId);
      expect(row).toMatchObject({ wallet_address: address, status: 'PENDING_VERIFICATION' });
      expect(Buffer.from(row.public_key!, 'base64')).toHaveLength(33);

      // the same key on a fresh row of someone else is the same occupant (matched by key, not only by wallet)
      const other = await createUser(db);
      await expect(agents.register(other, 'thief', undefined, publicKey, address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect(await countAgents(other)).toBe(0);
    });

    it('a key that is not this inj1 address\'s key, or is undecodable, is 400 AGENT_PUBLIC_KEY_MISMATCH and writes nothing; a missing key is AGENT_PUBLIC_KEY_REQUIRED', async () => {
      const ownerId = await createUser(db);
      const { address } = injKey();
      for (const key of [injKey().publicKey, Wallet.createRandom().signingKey.compressedPublicKey, 'BAAA', 'not-a-key']) {
        await expect(agents.register(ownerId, 'bot', undefined, key, address)).rejects.toMatchObject({ status: 400, message: 'AGENT_PUBLIC_KEY_MISMATCH' });
      }
      await expect(agents.register(ownerId, 'bot', undefined, undefined, address)).rejects.toMatchObject({ status: 400, message: 'AGENT_PUBLIC_KEY_REQUIRED' });
      expect(await countAgents(ownerId)).toBe(0);
    });

    it('a different PENDING key holder: another owner\'s fresh PENDING row on the same public key blocks (409), an abandoned one (>24h) is soft-deleted and taken over', async () => {
      const { address, publicKey } = injKey();
      const squatter = await createUser(db);
      const squat = await agents.register(squatter, 'squat', undefined, publicKey, address);
      const other = await createUser(db);
      await expect(agents.register(other, 'late', undefined, publicKey, address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      await db.query(`UPDATE agent SET created_at = now() - interval '25 hours' WHERE id = $1`, [squat.agentId]);
      const takeover = await agents.register(other, 'late', undefined, publicKey, address);
      expect(takeover.agentId).not.toBe(squat.agentId);
      expect((await agentRow(squat.agentId)).deleted_at).toBeInstanceOf(Date);
      expect(await agentRow(takeover.agentId)).toMatchObject({ owner_user_id: other, deleted_at: null });
    });

    it('re-registering my own pending wallet returns the same row and applies the new name and description; another owner\'s pending row is never handed out (409)', async () => {
      const ownerId = await createUser(db);
      const other = await createUser(db);
      const signer = Wallet.createRandom();
      const first = await agents.register(ownerId, 'old', 'old description', undefined, signer.address);
      const second = await agents.register(ownerId, 'Renamed Bot', undefined, undefined, signer.address);
      expect(second.agentId).toBe(first.agentId);
      expect(await agentRow(first.agentId)).toMatchObject({ name: 'Renamed Bot', description: null, status: 'PENDING_VERIFICATION' });
      await expect(agents.register(other, 'x', undefined, undefined, signer.address)).rejects.toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect(await agentRow(first.agentId)).toMatchObject({ name: 'Renamed Bot' }); // the failed attempt did not rename it

      // a verified agent's name is not changed by registering its wallet again
      await agents.verifyAndIssueKey(ownerId, first.agentId, await signer.signMessage(first.verificationMessage));
      await expect(agents.register(ownerId, 'renamed again', undefined, undefined, signer.address)).rejects.toMatchObject({ message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect(await agentRow(first.agentId)).toMatchObject({ name: 'Renamed Bot', status: 'ACTIVE' });
    });

    it('the owner\'s own connected wallet (as 0x, as inj1, in either letter case) cannot be an agent wallet: 400, and the rollback also undoes retiring an abandoned squat; a disconnected wallet does not count', async () => {
      const ownerId = await createUser(db);
      const mine = Wallet.createRandom();
      await db.query(`INSERT INTO wallet (user_id, chain, address, is_primary, verified_at) VALUES ($1, 'INJECTIVE', $2, true, now())`, [ownerId, getInjectiveAddress(mine.address)]);

      await expect(agents.register(ownerId, 'bot', undefined, undefined, mine.address)).rejects.toMatchObject({ status: 400, message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      const inj = injKey(mine);
      await expect(agents.register(ownerId, 'bot', undefined, inj.publicKey, inj.address)).rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      await expect(agents.register(ownerId, 'bot', undefined, inj.publicKey, inj.address.toUpperCase())).rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      expect(await countAgents(ownerId)).toBe(0);

      // someone's abandoned PENDING squat on this very wallet: the failed registration must not leave it soft-deleted
      const squatter = await createUser(db);
      const squat = await agents.register(squatter, 'squat', undefined, undefined, mine.address);
      await db.query(`UPDATE agent SET created_at = now() - interval '25 hours' WHERE id = $1`, [squat.agentId]);
      await expect(agents.register(ownerId, 'bot', undefined, undefined, mine.address)).rejects.toMatchObject({ message: 'AGENT_WALLET_IS_OWNER_WALLET' });
      expect((await agentRow(squat.agentId)).deleted_at).toBeNull();

      await db.query(`UPDATE wallet SET disconnected_at = now() WHERE user_id = $1`, [ownerId]);
      await db.query(`UPDATE agent SET deleted_at = now() WHERE id = $1`, [squat.agentId]);
      await expect(agents.register(ownerId, 'bot', undefined, undefined, mine.address)).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
      // a different dedicated wallet is fine while connected
      const connectedOwner = await createUser(db);
      await createPrimaryWallet(db, connectedOwner);
      await expect(agents.register(connectedOwner, 'bot', undefined, undefined, Wallet.createRandom().address)).resolves.toMatchObject({ status: 'PENDING_VERIFICATION' });
    });
  });

  describe('verify', () => {
    async function pending(ownerId: string, signer = Wallet.createRandom()) {
      const registered = await agents.register(ownerId, 'bot', undefined, undefined, signer.address);
      return { ...registered, signer };
    }

    it('an EVM verify activates the agent with the recovered key, issues a 90-day key stored only as prefix + sha256, and audits AGENT_VERIFIED', async () => {
      const ownerId = await createUser(db);
      const { agentId, signer, verificationMessage } = await pending(ownerId);
      const verified = await agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, verificationMessage));
      expect(verified.apiKey).toMatch(/^nj_[A-Za-z0-9_-]{43}$/);
      expect(await agentRow(agentId)).toMatchObject({ status: 'ACTIVE', public_key: signer.signingKey.compressedPublicKey });
      expect((await agentRow(agentId)).verified_at).toBeInstanceOf(Date);
      const keys = await keyRows(agentId);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatchObject({ key_prefix: agentApiKeyPrefix(verified.apiKey), key_hash: hashAgentApiKey(verified.apiKey), status: 'ACTIVE' });
      expect(keys[0].expires_at.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
      expect(new Date(verified.expiresAt).getTime()).toBe(keys[0].expires_at.getTime());
      expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_VERIFIED']);
    });

    it('an inj1 verify uses ADR-36 against the stored public key and the owner-bound message; a refused signature leaves the agent pending without a key', async () => {
      const ownerId = await createUser(db);
      const { address, publicKey } = injKey();
      const registered = await agents.register(ownerId, 'bot', undefined, publicKey, address);
      await expect(agents.verifyAndIssueKey(ownerId, registered.agentId, 'bad')).rejects.toMatchObject({ status: 401, message: 'INVALID_SIGNATURE' });
      expect(await agentRow(registered.agentId)).toMatchObject({ status: 'PENDING_VERIFICATION', verified_at: null });
      expect(await keyRows(registered.agentId)).toEqual([]);

      adr36.mockReturnValueOnce(true);
      const verified = await agents.verifyAndIssueKey(ownerId, registered.agentId, 'adr36-sig');
      expect(adr36).toHaveBeenLastCalledWith(address, AgentsService.verificationMessage(registered.agentId, ownerId), (await agentRow(registered.agentId)).public_key, 'adr36-sig');
      expect(verified).toMatchObject({ agentId: registered.agentId, status: 'ACTIVE' });
      expect(await agentRow(registered.agentId)).toMatchObject({ status: 'ACTIVE' });
    });

    it('a signature from another key, over another agent\'s or another owner\'s message, is 401 and consumes nothing; the old Korean-only text still verifies', async () => {
      const ownerId = await createUser(db);
      const { agentId, signer, verificationMessage } = await pending(ownerId);
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(Wallet.createRandom(), verificationMessage))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, AgentsService.verificationMessage(agentId, 'someone-else')))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
      expect(await keyRows(agentId)).toEqual([]);
      expect(await agentRow(agentId)).toMatchObject({ status: 'PENDING_VERIFICATION', public_key: null });

      const legacy = ['NinjaLabs AI 에이전트 등록 검증', `agentId: ${agentId}`, `owner: ${ownerId}`, '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.'].join('\n');
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, legacy))).resolves.toMatchObject({ status: 'ACTIVE' });
    });

    it.each([
      ['ACTIVE', 'verified', 'AGENT_ALREADY_VERIFIED'],
      ['REVOKED', 'verified', 'AGENT_ALREADY_VERIFIED'],
      ['SUSPENDED', 'verified', 'AGENT_ALREADY_VERIFIED'],
      ['REVOKED', 'never verified', 'AGENT_NOT_PENDING'],
      ['SUSPENDED', 'never verified', 'AGENT_NOT_PENDING'],
    ])('a %s agent that was %s is 409 %s and no key is issued', async (status, history, code) => {
      const ownerId = await createUser(db);
      const { agentId, signer, verificationMessage } = await pending(ownerId);
      await db.query(`UPDATE agent SET status = $2, verified_at = CASE WHEN $3 = 'verified' THEN now() END WHERE id = $1`, [agentId, status, history]);
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, verificationMessage))).rejects.toMatchObject({ status: 409, message: code });
      expect(await keyRows(agentId)).toEqual([]);
    });

    it('a verified EVM key is cleared off other EVM PENDING rows (legacy keys stored by older clients) so activation cannot hit uq_agent_public_key; inj1 verify leaves other rows alone', async () => {
      const signer = Wallet.createRandom();
      const key = signer.signingKey.compressedPublicKey;
      const attackerOwner = await createUser(db);
      // an older client stored someone's key on its own EVM PENDING row (no verification back then)
      const legacy = await agents.register(attackerOwner, 'legacy', undefined, undefined, Wallet.createRandom().address);
      await db.query(`UPDATE agent SET public_key = $2 WHERE id = $1`, [legacy.agentId, key]);

      const ownerId = await createUser(db);
      const { agentId, verificationMessage } = await pending(ownerId, signer);
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, verificationMessage))).resolves.toMatchObject({ status: 'ACTIVE' });
      expect((await agentRow(legacy.agentId)).public_key).toBeNull();
      expect((await agentRow(agentId)).public_key).toBe(key);

      // inj1: nothing else is touched
      const inj = injKey();
      const injOwner = await createUser(db);
      const injAgent = await agents.register(injOwner, 'inj', undefined, inj.publicKey, inj.address);
      const keyHolder = await agents.register(await createUser(db), 'evm', undefined, undefined, Wallet.createRandom().address);
      await db.query(`UPDATE agent SET public_key = '0x02aa' WHERE id = $1`, [keyHolder.agentId]);
      adr36.mockReturnValueOnce(true);
      await agents.verifyAndIssueKey(injOwner, injAgent.agentId, 'sig');
      expect((await agentRow(keyHolder.agentId)).public_key).toBe('0x02aa');
    });

    it('activation blocked by an ACTIVE agent holding the same key is 409 AGENT_KEY_OR_WALLET_ALREADY_REGISTERED (never a 500) and the whole verify rolls back', async () => {
      const signer = Wallet.createRandom();
      const holderOwner = await createUser(db);
      const holder = await agents.register(holderOwner, 'holder', undefined, undefined, Wallet.createRandom().address);
      await db.query(`UPDATE agent SET status = 'ACTIVE', verified_at = now(), public_key = $2 WHERE id = $1`, [holder.agentId, signer.signingKey.compressedPublicKey]);

      const ownerId = await createUser(db);
      const { agentId, verificationMessage } = await pending(ownerId, signer);
      await expect(agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, verificationMessage))).rejects.toMatchObject({ status: 409, message: 'AGENT_KEY_OR_WALLET_ALREADY_REGISTERED' });
      expect(await agentRow(agentId)).toMatchObject({ status: 'PENDING_VERIFICATION', verified_at: null });
      expect(await keyRows(agentId)).toEqual([]);
      expect(await auditActions(db, 'agent', agentId)).toEqual([]);
    });

    it('two concurrent verifies of the same agent issue exactly one key and one audit row; the loser waits on the row lock and gets AGENT_ALREADY_VERIFIED', async () => {
      const ownerId = await createUser(db);
      const { agentId, signer, verificationMessage } = await pending(ownerId);
      const signature = await sign(signer, verificationMessage);
      const results = await Promise.allSettled([
        agents.verifyAndIssueKey(ownerId, agentId, signature),
        agents.verifyAndIssueKey(ownerId, agentId, signature),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ message: 'AGENT_ALREADY_VERIFIED' });
      expect(await keyRows(agentId)).toHaveLength(1);
      expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_VERIFIED']);
    });

    it('every verify issues a fresh random key', async () => {
      const keys = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const ownerId = await createUser(db);
        const { agentId, signer, verificationMessage } = await pending(ownerId);
        keys.add((await agents.verifyAndIssueKey(ownerId, agentId, await sign(signer, verificationMessage))).apiKey);
      }
      expect(keys.size).toBe(3);
    });
  });

  describe('rotate, revoke and list', () => {
    async function activeAgent(ownerId: string) {
      const signer = Wallet.createRandom();
      const registered = await agents.register(ownerId, 'bot', undefined, undefined, signer.address);
      const verified = await agents.verifyAndIssueKey(ownerId, registered.agentId, await signer.signMessage(registered.verificationMessage));
      return { agentId: registered.agentId, apiKey: verified.apiKey, signer };
    }

    it('rotating revokes every ACTIVE key, inserts one 90-day key by hash and audits AGENT_KEY_ROTATED', async () => {
      const ownerId = await createUser(db);
      const { agentId, apiKey } = await activeAgent(ownerId);
      const rotated = await agents.rotateKey(ownerId, agentId);
      const keys = await keyRows(agentId);
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatchObject({ key_hash: hashAgentApiKey(apiKey), status: 'REVOKED' });
      expect(keys[0].revoked_at).toBeInstanceOf(Date);
      expect(keys[1]).toMatchObject({ key_prefix: agentApiKeyPrefix(rotated.apiKey), key_hash: hashAgentApiKey(rotated.apiKey), status: 'ACTIVE' });
      expect(keys[1].expires_at.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
      expect(new Date(rotated.expiresAt).getTime()).toBe(keys[1].expires_at.getTime());
      expect(await auditActions(db, 'agent', agentId)).toEqual(['AGENT_VERIFIED', 'AGENT_KEY_ROTATED']);
    });

    it.each([
      ['PENDING_VERIFICATION', 'AGENT_NOT_ACTIVE'],
      ['REVOKED', 'AGENT_NOT_ACTIVE'],
    ])('rotating a %s agent is 409 %s and issues nothing', async (status, code) => {
      const ownerId = await createUser(db);
      const { agentId } = await activeAgent(ownerId);
      await db.query(`UPDATE agent SET status = $2 WHERE id = $1`, [agentId, status]);
      await expect(agents.rotateKey(ownerId, agentId)).rejects.toMatchObject({ status: 409, message: code });
      expect(await keyRows(agentId)).toHaveLength(1);
    });

    it('revoking marks the agent and all ACTIVE keys REVOKED with one AGENT_REVOKED audit row; repeating it changes nothing and writes no second audit row', async () => {
      const ownerId = await createUser(db);
      const { agentId } = await activeAgent(ownerId);
      await expect(agents.revoke(ownerId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
      expect(await agentRow(agentId)).toMatchObject({ status: 'REVOKED', deleted_at: null });
      expect((await keyRows(agentId)).map((key) => key.status)).toEqual(['REVOKED']);
      expect((await keyRows(agentId))[0].revoked_at).toBeInstanceOf(Date);
      await expect(agents.revoke(ownerId, agentId)).resolves.toEqual({ agentId, status: 'REVOKED' });
      expect((await auditActions(db, 'agent', agentId)).filter((action) => action === 'AGENT_REVOKED')).toHaveLength(1);
    });

    it('someone else\'s or a soft-deleted agent is 404 AGENT_NOT_FOUND for rotate and revoke', async () => {
      const ownerId = await createUser(db);
      const { agentId } = await activeAgent(ownerId);
      const stranger = await createUser(db);
      await expect(agents.rotateKey(stranger, agentId)).rejects.toMatchObject({ status: 404, message: 'AGENT_NOT_FOUND' });
      await expect(agents.revoke(stranger, agentId)).rejects.toMatchObject({ status: 404, message: 'AGENT_NOT_FOUND' });
      await db.query(`UPDATE agent SET deleted_at = now() WHERE id = $1`, [agentId]);
      await expect(agents.rotateKey(ownerId, agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
      await expect(agents.revoke(ownerId, agentId)).rejects.toMatchObject({ message: 'AGENT_NOT_FOUND' });
    });

    it('myAgents lists each of my live agents exactly once, REVOKED ones included, oldest first, with the newest ACTIVE key (else the newest key) and a computed key_status; soft-deleted and other owners\' agents are hidden', async () => {
      const ownerId = await createUser(db);
      const first = await activeAgent(ownerId);
      await agents.rotateKey(ownerId, first.agentId); // two keys: the ACTIVE one must win over the newer-or-older revoked one
      const second = await activeAgent(ownerId);
      await agents.revoke(ownerId, second.agentId); // only a REVOKED key left
      const hidden = await activeAgent(ownerId);
      await db.query(`UPDATE agent SET deleted_at = now() WHERE id = $1`, [hidden.agentId]);
      await activeAgent(await createUser(db));
      await db.query(`UPDATE agent SET created_at = now() - interval '2 hours' WHERE id = $1`, [first.agentId]);
      await db.query(`UPDATE agent SET created_at = now() - interval '1 hour' WHERE id = $1`, [second.agentId]);

      const rows = await agents.myAgents(ownerId);
      expect(rows.map((row) => row.id)).toEqual([first.agentId, second.agentId]);
      const activeKey = (await keyRows(first.agentId)).find((key) => key.status === 'ACTIVE')!;
      expect(rows[0]).toMatchObject({ status: 'ACTIVE', key_status: 'ACTIVE', key_prefix: activeKey.key_prefix, completed_bounties: 0 });
      expect(rows[1]).toMatchObject({ status: 'REVOKED', key_status: 'REVOKED' });

      await db.query(`UPDATE agent_api_key SET expires_at = now() - interval '1 second' WHERE agent_id = $1 AND status = 'ACTIVE'`, [first.agentId]);
      expect((await agents.myAgents(ownerId))[0].key_status).toBe('EXPIRED');
      expect(await agents.myAgents(await createUser(db))).toEqual([]);
    });
  });
});
