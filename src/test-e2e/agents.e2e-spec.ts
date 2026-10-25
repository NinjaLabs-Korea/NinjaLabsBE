import { HDNodeWallet, Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, Session, startApp, UUID } from './support/harness';
import { getInjectiveAddress } from './support/injective-sdk.stub';

const badRequest = (message: string | string[]) => ({ statusCode: 400, error: 'Bad Request', message });
const unauthorized = (message: string) => ({ statusCode: 401, error: 'Unauthorized', message });

// agents — owner-facing registration/verify/rotate/revoke (/agents) and Agent API key auth (/agent-api/v1) over real HTTP
describeDb('agents over HTTP (e2e)', () => {
  let e2e: E2eApp;
  let owner: Session;
  beforeAll(async () => {
    e2e = await startApp();
    owner = await e2e.login();
  });
  afterAll(async () => e2e?.close());

  async function register(session: Session, signer: HDNodeWallet, name = 'e2e-bot') {
    const res = await e2e.post('/agents', { name, walletAddress: signer.address }, { token: session.accessToken });
    expect(res.status).toBe(201);
    return res.body as { agentId: string; status: string; verificationMessage: string };
  }

  async function activeAgent(session: Session = owner) {
    const signer = Wallet.createRandom();
    const registered = await register(session, signer);
    const verified = await e2e.post(`/agents/${registered.agentId}/verify`, { signature: await signer.signMessage(registered.verificationMessage) }, { token: session.accessToken });
    expect(verified.status).toBe(201);
    e2e.trackTokens(verified.body);
    return { signer, agentId: registered.agentId, apiKey: verified.body.apiKey as string };
  }

  describe('POST /agents', () => {
    it('requires a session (401) and validates the body: missing/non-string wallet, empty or over-long name → 400 before the service', async () => {
      expect((await e2e.post('/agents', { name: 'x', walletAddress: Wallet.createRandom().address })).status).toBe(401);

      const cases: unknown[] = [
        { name: 'bot' },
        { name: 'bot', walletAddress: 12345 },
        { name: 'bot', walletAddress: ['0xabc'] },
        { name: '   ', walletAddress: Wallet.createRandom().address },
        { name: 'n'.repeat(101), walletAddress: Wallet.createRandom().address },
        { name: 'bot', walletAddress: Wallet.createRandom().address, description: 'd'.repeat(1001) },
      ];
      for (const body of cases) {
        const res = await e2e.post('/agents', body, { token: owner.accessToken });
        expect({ body, status: res.status }).toEqual({ body, status: 400 });
        expect(res.body.statusCode).toBe(400);
      }
    });

    it('domain validation: bad EIP-55 checksum → 400 INVALID_AGENT_WALLET_ADDRESS; inj1 without publicKey → 400 AGENT_PUBLIC_KEY_REQUIRED', async () => {
      const broken = await e2e.post('/agents', { name: 'bot', walletAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD' }, { token: owner.accessToken });
      expect(broken.body).toEqual(badRequest('INVALID_AGENT_WALLET_ADDRESS'));
      const inj = await e2e.post('/agents', { name: 'bot', walletAddress: 'inj1qy352eufqy352eufqy352eufqy352eufpm6h0c' }, { token: owner.accessToken });
      expect(inj.body).toEqual(badRequest('AGENT_PUBLIC_KEY_REQUIRED'));
    });

    it('stores a lower-case 0x wallet in checksum form and trims the name', async () => {
      const signer = Wallet.createRandom();
      const res = await e2e.post('/agents', { name: '  trimmed-bot  ', walletAddress: signer.address.toLowerCase() }, { token: owner.accessToken });
      expect(res.status).toBe(201);
      const row = await e2e.db.query<{ name: string; wallet_address: string; status: string }>(
        `SELECT name, wallet_address, status FROM agent WHERE id = $1`, [res.body.agentId]);
      expect(row.rows[0]).toEqual({ name: 'trimmed-bot', wallet_address: signer.address, status: 'PENDING_VERIFICATION' });
    });

    it('registering the same wallet again while pending returns the same agent and challenge; another owner gets 409', async () => {
      const signer = Wallet.createRandom();
      const first = await register(owner, signer);
      expect(first).toEqual({ agentId: expect.stringMatching(UUID), status: 'PENDING_VERIFICATION', verificationMessage: expect.stringContaining(`owner: ${owner.userId}`) });
      const again = await register(owner, signer, 'renamed');
      expect(again).toEqual(first);

      const stranger = await e2e.login();
      const taken = await e2e.post('/agents', { name: 'squat', walletAddress: signer.address }, { token: stranger.accessToken });
      expect(taken.status).toBe(409);
      expect(taken.body.message).toBe('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
    });
  });

  describe('POST /agents/:id/verify', () => {
    it('a wrong signature is 401 INVALID_SIGNATURE and leaves the agent pending; the right one then activates it once (second verify 409)', async () => {
      const signer = Wallet.createRandom();
      const { agentId, verificationMessage } = await register(owner, signer);

      const impostor = Wallet.createRandom();
      const wrong = await e2e.post(`/agents/${agentId}/verify`, { signature: await impostor.signMessage(verificationMessage) }, { token: owner.accessToken });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual(unauthorized('INVALID_SIGNATURE'));
      const garbage = await e2e.post(`/agents/${agentId}/verify`, { signature: '0xnot-a-signature' }, { token: owner.accessToken });
      expect(garbage.status).toBe(401);

      const ok = await e2e.post(`/agents/${agentId}/verify`, { signature: await signer.signMessage(verificationMessage) }, { token: owner.accessToken });
      expect(ok.status).toBe(201);
      e2e.trackTokens(ok.body);
      expect(ok.body).toEqual({ agentId, status: 'ACTIVE', apiKey: expect.stringMatching(/^nj_[A-Za-z0-9_-]{43}$/), expiresAt: expect.any(String) });
      expect(ok.headers['cache-control']).toBe('no-store, private'); // the one-time API key must never sit in a shared cache (same rule as the token responses in auth.controller.ts)

      const twice = await e2e.post(`/agents/${agentId}/verify`, { signature: await signer.signMessage(verificationMessage) }, { token: owner.accessToken });
      expect(twice.status).toBe(409);
      expect(twice.body.message).toBe('AGENT_ALREADY_VERIFIED');
    });

    it('400 for a non-UUID id or a missing signature; 404 AGENT_NOT_FOUND for someone else\'s agent', async () => {
      expect((await e2e.post('/agents/not-a-uuid/verify', { signature: '0x00' }, { token: owner.accessToken })).status).toBe(400);
      const signer = Wallet.createRandom();
      const { agentId, verificationMessage } = await register(owner, signer);
      const missing = await e2e.post(`/agents/${agentId}/verify`, {}, { token: owner.accessToken });
      expect(missing.status).toBe(400);

      const stranger = await e2e.login();
      const foreign = await e2e.post(`/agents/${agentId}/verify`, { signature: await signer.signMessage(verificationMessage) }, { token: stranger.accessToken });
      expect(foreign.status).toBe(404);
      expect(foreign.body.message).toBe('AGENT_NOT_FOUND');
    });
  });

  describe('public key pre-claiming (an unverified key must never block its owner)', () => {
    const agentKey = async (agentId: string) =>
      (await e2e.db.query<{ public_key: string | null }>(`SELECT public_key FROM agent WHERE id = $1`, [agentId])).rows[0].public_key;

    it("EVM: an attacker registering their own 0x wallet with the victim's publicKey stores NULL — the victim's verify is 201, not a 500", async () => {
      const attacker = await e2e.login();
      const victim = await e2e.login();
      const attackerWallet = Wallet.createRandom();
      const victimWallet = Wallet.createRandom();

      // 1. attacker: own wallet + the victim's compressed key (the format verify stores for EVM)
      const squat = await e2e.post('/agents', { name: 'squat', walletAddress: attackerWallet.address, publicKey: victimWallet.signingKey.compressedPublicKey }, { token: attacker.accessToken });
      expect(squat.status).toBe(201);
      expect(await agentKey(squat.body.agentId)).toBeNull();
      // 2. victim registers without a publicKey; 3. verify recovers the key from the signature and activates
      const registered = await register(victim, victimWallet);
      const verified = await e2e.post(`/agents/${registered.agentId}/verify`, { signature: await victimWallet.signMessage(registered.verificationMessage) }, { token: victim.accessToken });
      expect(verified.status).toBe(201);
      e2e.trackTokens(verified.body);
      expect(verified.body).toMatchObject({ agentId: registered.agentId, status: 'ACTIVE' });
      expect(await agentKey(registered.agentId)).toBe(victimWallet.signingKey.compressedPublicKey);
      // the attacker's row is untouched otherwise and can still be verified by its real key holder
      const attackerVerify = await e2e.post(`/agents/${squat.body.agentId}/verify`, { signature: await attackerWallet.signMessage(squat.body.verificationMessage) }, { token: attacker.accessToken });
      expect(attackerVerify.status).toBe(201);
      e2e.trackTokens(attackerVerify.body);
      expect(await agentKey(squat.body.agentId)).toBe(attackerWallet.signingKey.compressedPublicKey);
    });

    it("EVM: a squat row stored before this fix (a PENDING 0x agent holding the victim's key) is cleared by the victim's verify → 201", async () => {
      const attacker = await e2e.login();
      const victim = await e2e.login();
      const victimWallet = Wallet.createRandom();
      const legacy = await e2e.db.query<{ id: string }>(
        `INSERT INTO agent (owner_user_id, name, public_key, wallet_address) VALUES ($1, 'legacy-squat', $2, $3) RETURNING id`,
        [attacker.userId, victimWallet.signingKey.compressedPublicKey, Wallet.createRandom().address]);

      const registered = await register(victim, victimWallet);
      const verified = await e2e.post(`/agents/${registered.agentId}/verify`, { signature: await victimWallet.signMessage(registered.verificationMessage) }, { token: victim.accessToken });
      expect(verified.status).toBe(201);
      e2e.trackTokens(verified.body);
      expect(await agentKey(legacy.rows[0].id)).toBeNull();
      expect(await agentKey(registered.agentId)).toBe(victimWallet.signingKey.compressedPublicKey);
    });

    it('EVM: if the recovered key is held by an ACTIVE agent anyway (data drift), verify is 409 AGENT_KEY_OR_WALLET_ALREADY_REGISTERED and stays pending', async () => {
      const other = await e2e.login();
      const victim = await e2e.login();
      const victimWallet = Wallet.createRandom();
      await e2e.db.query(
        `INSERT INTO agent (owner_user_id, name, public_key, wallet_address, status, verified_at) VALUES ($1, 'drift', $2, $3, 'ACTIVE', now())`,
        [other.userId, victimWallet.signingKey.compressedPublicKey, Wallet.createRandom().address]);

      const registered = await register(victim, victimWallet);
      const verified = await e2e.post(`/agents/${registered.agentId}/verify`, { signature: await victimWallet.signMessage(registered.verificationMessage) }, { token: victim.accessToken });
      expect(verified.status).toBe(409);
      expect(verified.body.message).toBe('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
      const row = await e2e.db.query(`SELECT status, public_key FROM agent WHERE id = $1`, [registered.agentId]);
      expect(row.rows[0]).toEqual({ status: 'PENDING_VERIFICATION', public_key: null });
    });

    it("inj1: a publicKey that is not the wallet's own key is 400 AGENT_PUBLIC_KEY_MISMATCH, so the victim's own registration still goes through", async () => {
      const attacker = await e2e.login();
      const victim = await e2e.login();
      const injKey = (signer: HDNodeWallet) => ({
        walletAddress: getInjectiveAddress(signer.address),
        publicKey: Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64'),
      });
      const victimKey = injKey(Wallet.createRandom());
      const attackerKey = injKey(Wallet.createRandom());

      const squat = await e2e.post('/agents', { name: 'squat', walletAddress: attackerKey.walletAddress, publicKey: victimKey.publicKey }, { token: attacker.accessToken });
      expect(squat.body).toEqual(badRequest('AGENT_PUBLIC_KEY_MISMATCH'));
      const garbage = await e2e.post('/agents', { name: 'bot', walletAddress: attackerKey.walletAddress, publicKey: 'not-a-key' }, { token: attacker.accessToken });
      expect(garbage.body).toEqual(badRequest('AGENT_PUBLIC_KEY_MISMATCH'));

      const own = await e2e.post('/agents', { name: 'inj-bot', ...victimKey }, { token: victim.accessToken });
      expect(own.status).toBe(201);
      expect(await agentKey(own.body.agentId)).toBe(victimKey.publicKey);
    });

    it('inj1: the stored public key is the canonical spelling, not the (possibly padded with ignorable characters) string the client sent', async () => {
      const bot = await e2e.login();
      const signer = Wallet.createRandom();
      const key = Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64');
      const res = await e2e.post('/agents', { name: 'padded', walletAddress: getInjectiveAddress(signer.address), publicKey: `${key.slice(0, 20)}\n${key.slice(20).replace(/=+$/, '')}${'!'.repeat(20_000)}` }, { token: bot.accessToken });
      expect(res.status).toBe(201);
      expect(await agentKey(res.body.agentId)).toBe(key);
    });
  });

  describe('rotate / revoke / list', () => {
    it('rotating a pending agent is 409 AGENT_NOT_ACTIVE; revoke is idempotent and a revoked agent cannot rotate', async () => {
      const pending = await register(owner, Wallet.createRandom());
      const rotatePending = await e2e.post(`/agents/${pending.agentId}/keys/rotate`, undefined, { token: owner.accessToken });
      expect(rotatePending.status).toBe(409);
      expect(rotatePending.body.message).toBe('AGENT_NOT_ACTIVE');

      const { agentId, apiKey } = await activeAgent();
      for (let i = 0; i < 2; i++) {
        const revoked = await e2e.post(`/agents/${agentId}/revoke`, undefined, { token: owner.accessToken });
        expect(revoked.status).toBe(201);
        expect(revoked.body).toEqual({ agentId, status: 'REVOKED' });
      }
      expect((await e2e.get('/agent-api/v1/me', { token: apiKey })).body).toEqual(unauthorized('INVALID_AGENT_API_KEY'));
      expect((await e2e.post(`/agents/${agentId}/keys/rotate`, undefined, { token: owner.accessToken })).status).toBe(409);
    });

    it('GET /agents/me exposes only the key prefix of the current key — never the raw key or its hash', async () => {
      const session = await e2e.login();
      const { agentId, apiKey } = await activeAgent(session);
      const listed = await e2e.get('/agents/me', { token: session.accessToken });
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([expect.objectContaining({ id: agentId, status: 'ACTIVE', key_prefix: apiKey.slice(0, 11), key_status: 'ACTIVE' })]);
      expect(listed.text).not.toContain(apiKey);
      expect(listed.text).not.toContain('key_hash');

      const rotated = await e2e.post(`/agents/${agentId}/keys/rotate`, undefined, { token: session.accessToken });
      e2e.trackTokens(rotated.body);
      expect(rotated.headers['cache-control']).toBe('no-store, private');
      const after = await e2e.get('/agents/me', { token: session.accessToken });
      expect(after.body).toHaveLength(1);
      expect(after.body[0].key_prefix).toBe(rotated.body.apiKey.slice(0, 11));
      expect((await e2e.get('/agents/me')).status).toBe(401);
    });
  });

  describe('Agent API key auth', () => {
    it('GET /agent-api/v1/me returns the principal for a valid key; the scheme is case-insensitive', async () => {
      const { agentId, apiKey, signer } = await activeAgent();
      const me = await e2e.get('/agent-api/v1/me', { headers: { authorization: `bearer ${apiKey}` } });
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ agentId, ownerUserId: owner.userId, name: 'e2e-bot', walletAddress: signer.address, status: 'ACTIVE' });
    });

    it('401 for a non-Bearer scheme (MISSING), a session JWT used as a key, an expired key and a key with a valid prefix but wrong tail (INVALID)', async () => {
      const { agentId, apiKey } = await activeAgent();
      expect((await e2e.get('/agent-api/v1/me', { headers: { authorization: `Basic ${apiKey}` } })).body).toEqual(unauthorized('MISSING_AGENT_API_KEY'));
      expect((await e2e.get('/agent-api/v1/me', { token: owner.accessToken })).body).toEqual(unauthorized('INVALID_AGENT_API_KEY'));
      const tampered = `${apiKey.slice(0, -1)}${apiKey.endsWith('A') ? 'B' : 'A'}`;
      expect((await e2e.get('/agent-api/v1/me', { token: tampered })).body).toEqual(unauthorized('INVALID_AGENT_API_KEY'));

      await e2e.db.query(`UPDATE agent_api_key SET expires_at = now() - interval '1 minute' WHERE agent_id = $1`, [agentId]);
      expect((await e2e.get('/agent-api/v1/me', { token: apiKey })).body).toEqual(unauthorized('INVALID_AGENT_API_KEY'));
      const listed = await e2e.get('/agents/me', { token: owner.accessToken });
      expect(listed.body.find((a: { id: string }) => a.id === agentId).key_status).toBe('EXPIRED');
    });

    it('a session token cannot reach the Agent API routes and an agent key cannot reach session routes', async () => {
      const { apiKey } = await activeAgent();
      expect((await e2e.get('/agents/me', { token: apiKey })).status).toBe(401);
      expect((await e2e.post('/agent-api/v1/bounties/00000000-0000-4000-8000-000000000000/applications', { message: 'hi' }, { token: owner.accessToken })).status).toBe(401);
    });
    it('the per-key budget (60/min) follows the agent, not the key: rotating does not reset it; failed auth does not spend it', async () => {
      const session = await e2e.login();
      const { agentId, apiKey } = await activeAgent(session);
      // bad-key calls are rejected by AgentApiGuard before the throttler and must not count against anyone
      for (let i = 0; i < 5; i++) expect((await e2e.get('/agent-api/v1/me', { token: `${apiKey.slice(0, 11)}${'z'.repeat(32)}` })).status).toBe(401);
      for (let i = 0; i < 60; i++) {
        const res = await e2e.get('/agent-api/v1/me', { token: apiKey });
        expect(res.status).toBe(200);
        expect(res.headers['x-ratelimit-remaining-agent-api']).toBe(String(59 - i));
      }
      const rotated = await e2e.post(`/agents/${agentId}/keys/rotate`, undefined, { token: session.accessToken });
      e2e.trackTokens(rotated.body);
      const limited = await e2e.get('/agent-api/v1/me', { token: rotated.body.apiKey });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers['retry-after-agent-api'])).toBeGreaterThan(0);
    });
  });
});
