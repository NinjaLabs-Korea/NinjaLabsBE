import { HDNodeWallet, Wallet } from 'ethers';
import { describeDb } from '../test-db/describe-db';
import { E2eApp, Session, startApp, UUID } from './support/harness';

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
