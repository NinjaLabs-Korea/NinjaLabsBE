import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Wallet } from 'ethers';
import { AuditService } from '../audit/audit.service';
import { verifyAdr36Signature } from '../common/crypto/adr36';
import { getInjectiveAddress } from '../test-e2e/support/injective-sdk.stub';
import { createMockDb } from '../test-support/mock-db';
import { agentApiKeyPrefix, hashAgentApiKey } from './agent-api-key';
import { AgentsService } from './agents.service';

// sdk-ts is ESM-only: the e2e stub implements the inj1 <-> 0x helpers with real bech32 (byte-identical to sdk-ts)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

const agentId = '11111111-1111-4111-8111-111111111111';
const ownerUserId = '22222222-2222-4222-8222-222222222222';
/** A real Injective key pair: inj1 = bech32 of the EVM address, publicKey = compressed key in base64 (Keplr pub_key.value) */
const injKey = (signer = Wallet.createRandom()) => ({
  address: getInjectiveAddress(signer.address),
  publicKey: Buffer.from(signer.signingKey.compressedPublicKey.slice(2), 'hex').toString('base64'),
});
const { address: INJ_ADDRESS, publicKey: INJ_PUBKEY } = injKey();

/** register()/verify() against a scripted tx: every statement is checked for $n/params drift. */
function setup(options: {
  insertError?: unknown;
  pendingAfterConflict?: boolean;
  verifyRow?: { status: string; public_key: string | null; wallet_address: string; verified_at?: Date | null } | null;
  activateError?: unknown;
  ownerWallets?: string[];
  onboarded?: boolean;
} = {}) {
  const txQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM wallet WHERE user_id = $1 AND disconnected_at IS NULL')) {
      return { rowCount: (options.ownerWallets ?? []).length, rows: (options.ownerWallets ?? []).map((address) => ({ address })) };
    }
    if (sql.includes('onboarding_completed_at IS NOT NULL AS done')) return { rowCount: 1, rows: [{ done: options.onboarded ?? true }] };
    if (sql.includes("status IN ('REVOKED', 'PENDING_VERIFICATION')")) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO agent (')) {
      if (options.insertError) throw options.insertError;
      return { rowCount: 1, rows: [{ id: agentId }] };
    }
    if (sql.includes('SELECT status, public_key, wallet_address, verified_at FROM agent')) {
      const row = options.verifyRow;
      return row ? { rowCount: 1, rows: [row] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes("SET status = 'ACTIVE'") && options.activateError) throw options.activateError;
    if (sql.includes('INSERT INTO agent_api_key')) return { rowCount: 1, rows: [{ expires_at: '2027-01-01T00:00:00.000Z' }] };
    return { rowCount: 1, rows: [] };
  });
  const query = jest.fn(async (_sql: string, _params?: unknown[]) =>
    options.pendingAfterConflict ? { rowCount: 1, rows: [{ id: 'own-pending' }] } : { rowCount: 0, rows: [] });
  const { database, db } = createMockDb({ query, txQuery });
  const service = new AgentsService(database, new AuditService(database));
  return { service, db, txQuery, query };
}

describe('AgentsService.register input validation', () => {
  it('rejects a 0x address with a broken EIP-55 checksum with 400 INVALID_AGENT_WALLET_ADDRESS before touching the database', async () => {
    const { service, db } = setup();
    // EIP-55 reference vector 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed with the case of its last letter flipped
    const broken = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD';
    const error = await service.register(ownerUserId, 'bot', undefined, undefined, broken).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe('INVALID_AGENT_WALLET_ADDRESS');
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, '0x1234')).rejects.toMatchObject({ message: 'INVALID_AGENT_WALLET_ADDRESS' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('rejects an inj1 wallet without a public key with 400 AGENT_PUBLIC_KEY_REQUIRED', async () => {
    const { service, db } = setup();
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, INJ_ADDRESS)).rejects.toMatchObject({ status: 400, message: 'AGENT_PUBLIC_KEY_REQUIRED' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  // the address is classified first: a wrong address is named as such even when a (valid) public key was sent
  it.each([
    ['an address that is neither 0x nor inj1', 'cosmos1qy352eufqy352eufqy352eufqy352euf0abc'],
    ['cosmos1abc', 'cosmos1abc'],
    ['a mixed-case inj1 address (bech32 is all lower or all upper)', `${INJ_ADDRESS.slice(0, 10)}${INJ_ADDRESS.slice(10).toUpperCase()}`],
    ['a too short inj1 address', INJ_ADDRESS.slice(0, 20)],
    ['an inj1 contract-length address', `${INJ_ADDRESS}qqqqqqqqqqqqqqqqqqqq`],
  ])('rejects %s with 400 INVALID_AGENT_WALLET_ADDRESS even with a public key', async (_label, address) => {
    const { service, db } = setup();
    await expect(service.register(ownerUserId, 'bot', undefined, INJ_PUBKEY, address)).rejects.toMatchObject({ status: 400, message: 'INVALID_AGENT_WALLET_ADDRESS' });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('an all-upper-case INJ1 address is folded to lower case and registered like the lower-case one', async () => {
    const { service, txQuery } = setup();
    await expect(service.register(ownerUserId, 'bot', undefined, INJ_PUBKEY, INJ_ADDRESS.toUpperCase())).resolves.toMatchObject({ agentId, status: 'PENDING_VERIFICATION' });
    expect(txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent ('))![1]).toContain(INJ_ADDRESS);
  });

  it('trims an inj1 address, stores it unchanged otherwise, and binds the public key to both the occupancy check and the INSERT', async () => {
    const { service, txQuery } = setup();
    await expect(service.register(ownerUserId, 'bot', 'desc', INJ_PUBKEY, `  ${INJ_ADDRESS}  `)).resolves.toEqual({
      agentId,
      status: 'PENDING_VERIFICATION',
      verificationMessage: AgentsService.verificationMessage(agentId, ownerUserId),
    });
    expect(txQuery.mock.calls.find(([sql]) => sql.includes("status IN ('REVOKED', 'PENDING_VERIFICATION')"))?.[1]).toEqual([INJ_ADDRESS, INJ_PUBKEY]);
    expect(txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent ('))?.[1]).toEqual([ownerUserId, 'bot', 'desc', INJ_PUBKEY, INJ_ADDRESS]);
  });

  it.each([
    ['the same inj1 address', () => ({ wallet: INJ_ADDRESS, owner: INJ_ADDRESS })],
    ['the 0x form of the same account (wallets are stored as inj1)', () => { const signer = Wallet.createRandom(); return { wallet: signer.address, owner: getInjectiveAddress(signer.address) }; }],
    ['the same address in another letter case', () => ({ wallet: INJ_ADDRESS, owner: INJ_ADDRESS.toUpperCase() })],
  ])('refuses to register %s as the owner\'s own connected wallet (400 AGENT_WALLET_IS_OWNER_WALLET) and rolls the transaction back', async (_label, pick) => {
    const { wallet, owner } = pick();
    const { service, txQuery } = setup({ ownerWallets: [owner] });
    const error = await service.register(ownerUserId, 'bot', undefined, wallet === INJ_ADDRESS ? INJ_PUBKEY : undefined, wallet).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe('AGENT_WALLET_IS_OWNER_WALLET');
    const lookup = txQuery.mock.calls.find(([sql]) => sql.includes('FROM wallet WHERE user_id = $1'))!;
    expect(lookup[1]).toEqual([ownerUserId]);
  });

  it('an owner who has not finished onboarding is 409 PROFILE_REQUIRED before locking or inserting agents', async () => {
    const { service, txQuery } = setup({ onboarded: false });
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, Wallet.createRandom().address)).rejects.toMatchObject({
      status: 409,
      message: 'PROFILE_REQUIRED',
    });
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][0]).toContain('FOR SHARE');
  });

  it('a different dedicated wallet is fine even when the owner has a connected wallet', async () => {
    const { service } = setup({ ownerWallets: [getInjectiveAddress(Wallet.createRandom().address)] });
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, Wallet.createRandom().address)).resolves.toMatchObject({ agentId });
  });

  it('an EVM wallet ignores a client publicKey: NULL is stored and the key is not used for the occupancy check (it comes from the signature at verify)', async () => {
    const signer = Wallet.createRandom();
    const someoneElsesKey = Wallet.createRandom().signingKey.compressedPublicKey;
    const { service, txQuery } = setup();
    await expect(service.register(ownerUserId, 'bot', undefined, someoneElsesKey, signer.address)).resolves.toMatchObject({ agentId });
    expect(txQuery.mock.calls.find(([sql]) => sql.includes("status IN ('REVOKED', 'PENDING_VERIFICATION')"))?.[1]).toEqual([signer.address, null]);
    expect(txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent ('))?.[1]).toEqual([ownerUserId, 'bot', null, null, signer.address]);
  });

  it.each([
    ['the key of another wallet', () => injKey().publicKey],
    ['an EVM-style hex key', () => Wallet.createRandom().signingKey.compressedPublicKey],
    ['a too-short key', () => 'BAAA'],
    ['undecodable garbage', () => 'not-a-key'],
  ])('an inj1 wallet with %s is 400 AGENT_PUBLIC_KEY_MISMATCH before touching the database (no pre-claiming of someone else\'s key)', async (_label, key) => {
    const { service, db } = setup();
    await expect(service.register(ownerUserId, 'bot', undefined, key(), INJ_ADDRESS)).rejects.toMatchObject({
      status: 400,
      message: 'AGENT_PUBLIC_KEY_MISMATCH',
    });
    expect(db.tx).not.toHaveBeenCalled();
  });

  it('a unique violation with no own PENDING row on that wallet is 409 AGENT_KEY_OR_WALLET_ALREADY_REGISTERED', async () => {
    const signer = Wallet.createRandom();
    const { service, query } = setup({ insertError: Object.assign(new Error('dup'), { code: '23505' }) });
    const error = await service.register(ownerUserId, 'bot', undefined, undefined, signer.address).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
    expect(query.mock.calls[0][1]).toEqual([ownerUserId, signer.address, 'bot', null]);
  });

  it('re-registering the same pending wallet applies the new name and description to the existing row and returns its id', async () => {
    const signer = Wallet.createRandom();
    const { service, query } = setup({ insertError: Object.assign(new Error('dup'), { code: '23505' }), pendingAfterConflict: true });
    await expect(service.register(ownerUserId, 'Renamed Bot', 'new description', undefined, signer.address)).resolves.toMatchObject({ agentId: 'own-pending', status: 'PENDING_VERIFICATION' });
    expect(query.mock.calls[0][0]).toContain('UPDATE agent SET name = $3, description = $4');
    expect(query.mock.calls[0][1]).toEqual([ownerUserId, signer.address, 'Renamed Bot', 'new description']);
  });

  it('rethrows non-unique database errors unchanged (no pending lookup, no 409 mask)', async () => {
    const boom = Object.assign(new Error('connection reset'), { code: '08006' });
    const { service, query } = setup({ insertError: boom });
    await expect(service.register(ownerUserId, 'bot', undefined, undefined, Wallet.createRandom().address)).rejects.toBe(boom);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('AgentsService.verifyAndIssueKey guards', () => {
  it('404 AGENT_NOT_FOUND when the agent is not the caller\'s (or deleted) — scoped by (id, owner)', async () => {
    const { service, txQuery } = setup({ verifyRow: null });
    const error = await service.verifyAndIssueKey(ownerUserId, agentId, '0xsig').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toBe('AGENT_NOT_FOUND');
    expect(txQuery.mock.calls[0][0]).toContain('deleted_at IS NULL');
    expect(txQuery.mock.calls[0][1]).toEqual([agentId, ownerUserId]);
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ACTIVE', null], ['REVOKED', new Date()], ['SUSPENDED', new Date()],
  ])('409 AGENT_ALREADY_VERIFIED for a %s agent that was verified, issuing no key', async (status, verified_at) => {
    const { service, txQuery } = setup({ verifyRow: { status, public_key: null, wallet_address: Wallet.createRandom().address, verified_at } });
    await expect(service.verifyAndIssueKey(ownerUserId, agentId, '0xsig')).rejects.toMatchObject({ status: 409, message: 'AGENT_ALREADY_VERIFIED' });
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent_api_key'))).toBe(false);
  });

  it.each(['REVOKED', 'SUSPENDED'])('409 AGENT_NOT_PENDING (not "already verified") for a %s agent that never verified, issuing no key', async (status) => {
    const { service, txQuery } = setup({ verifyRow: { status, public_key: null, wallet_address: Wallet.createRandom().address, verified_at: null } });
    await expect(service.verifyAndIssueKey(ownerUserId, agentId, '0xsig')).rejects.toMatchObject({ status: 409, message: 'AGENT_NOT_PENDING' });
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO agent_api_key'))).toBe(false);
  });

  it('401 INVALID_SIGNATURE for an EVM signature over a different message, without activating the agent', async () => {
    const signer = Wallet.createRandom();
    const { service, txQuery } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address } });
    const wrong = await signer.signMessage(AgentsService.verificationMessage(agentId, 'someone-else'));
    const error = await service.verifyAndIssueKey(ownerUserId, agentId, wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as Error).message).toBe('INVALID_SIGNATURE');
    expect(txQuery.mock.calls.some(([sql]) => sql.includes("SET status = 'ACTIVE'"))).toBe(false);
  });

  it('inj1 agents are verified with ADR-36 against the stored public key and the owner-bound message; a valid one issues a hashed key', async () => {
    const mocked = verifyAdr36Signature as jest.Mock;
    mocked.mockReturnValueOnce(true);
    const { service, txQuery } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: INJ_PUBKEY, wallet_address: INJ_ADDRESS } });

    const verified = await service.verifyAndIssueKey(ownerUserId, agentId, 'adr36-sig');

    expect(mocked).toHaveBeenLastCalledWith(INJ_ADDRESS, AgentsService.verificationMessage(agentId, ownerUserId), INJ_PUBKEY, 'adr36-sig');
    expect(verified).toMatchObject({ agentId, status: 'ACTIVE', expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(verified.apiKey).toMatch(/^nj_[A-Za-z0-9_-]{43}$/);
    const activate = txQuery.mock.calls.find(([sql]) => sql.includes("SET status = 'ACTIVE'"))!;
    expect(activate[1]).toEqual([agentId, INJ_PUBKEY]);
    const insert = txQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO agent_api_key'))!;
    // only the lookup prefix and the sha256 are stored — never the raw key
    expect(insert[1]).toEqual([agentId, agentApiKeyPrefix(verified.apiKey), hashAgentApiKey(verified.apiKey)]);
    expect(insert[1]).not.toContain(verified.apiKey);
  });

  it('inj1 agent with a failing ADR-36 check is 401 INVALID_SIGNATURE', async () => {
    const { service } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: INJ_PUBKEY, wallet_address: INJ_ADDRESS } });
    await expect(service.verifyAndIssueKey(ownerUserId, agentId, 'bad')).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
  });

  it('an EVM verify first clears the recovered key off other EVM PENDING rows (unverified keys stored by older clients), then activates', async () => {
    const signer = Wallet.createRandom();
    const { service, txQuery } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address } });
    await service.verifyAndIssueKey(ownerUserId, agentId, await signer.signMessage(AgentsService.verificationMessage(agentId, ownerUserId)));
    const statements = txQuery.mock.calls.map(([sql]) => sql);
    const clear = statements.findIndex((sql) => sql.includes('SET public_key = NULL'));
    const activate = statements.findIndex((sql) => sql.includes("SET status = 'ACTIVE'"));
    expect(clear).toBeGreaterThan(0);
    expect(clear).toBeLessThan(activate);
    expect(statements[clear]).toContain("status = 'PENDING_VERIFICATION'");
    expect(statements[clear]).toContain("wallet_address ILIKE '0x%'");
    expect(txQuery.mock.calls[clear][1]).toEqual([signer.signingKey.compressedPublicKey, agentId]);
  });

  it('the verification message lists English, Korean and Chinese plus the no-gas line, bound to the agent and the owner', () => {
    const message = AgentsService.verificationMessage(agentId, ownerUserId);
    expect(message).toContain('AI agent registration verification');
    expect(message).toContain('AI 에이전트 등록 검증');
    expect(message).toContain('AI 代理注册验证');
    expect(message).toContain('costs no gas');
    expect(message).toContain(`agentId: ${agentId}`);
    expect(message).toContain(`owner: ${ownerUserId}`);
  });

  it('a pending agent whose owner signed the old Korean-only text still verifies; a signature over another agent does not', async () => {
    const signer = Wallet.createRandom();
    const legacy = ['NinjaLabs AI 에이전트 등록 검증', `agentId: ${agentId}`, `owner: ${ownerUserId}`, '이 서명은 트랜잭션을 발생시키지 않으며 가스비가 들지 않습니다.'].join('\n');
    const { service } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address } });
    await expect(service.verifyAndIssueKey(ownerUserId, agentId, await signer.signMessage(legacy))).resolves.toMatchObject({ status: 'ACTIVE' });
    const other = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address } });
    await expect(other.service.verifyAndIssueKey(ownerUserId, agentId, await signer.signMessage(legacy.replace(agentId, 'other')))).rejects.toMatchObject({ message: 'INVALID_SIGNATURE' });
  });

  it('an inj1 verify does not touch other rows (its key was checked against the address at register)', async () => {
    (verifyAdr36Signature as jest.Mock).mockReturnValueOnce(true);
    const { service, txQuery } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: INJ_PUBKEY, wallet_address: INJ_ADDRESS } });
    await service.verifyAndIssueKey(ownerUserId, agentId, 'adr36-sig');
    expect(txQuery.mock.calls.some(([sql]) => sql.includes('SET public_key = NULL'))).toBe(false);
  });

  it('a uq_agent_public_key violation on activation is 409 AGENT_KEY_OR_WALLET_ALREADY_REGISTERED, never a 500', async () => {
    const signer = Wallet.createRandom();
    const dup = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_agent_public_key' });
    const { service } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address }, activateError: dup });
    const signature = await signer.signMessage(AgentsService.verificationMessage(agentId, ownerUserId));
    const error = await service.verifyAndIssueKey(ownerUserId, agentId, signature).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe('AGENT_KEY_OR_WALLET_ALREADY_REGISTERED');
  });

  it('other database errors on activation are rethrown unchanged (a different unique index is not masked as 409)', async () => {
    const signer = Wallet.createRandom();
    const other = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_agent_wallet' });
    const { service } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address }, activateError: other });
    const signature = await signer.signMessage(AgentsService.verificationMessage(agentId, ownerUserId));
    await expect(service.verifyAndIssueKey(ownerUserId, agentId, signature)).rejects.toBe(other);
  });

  it('issues a fresh random key on every verify (no fixed or reused key material)', async () => {
    const signer = Wallet.createRandom();
    const keys = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { service } = setup({ verifyRow: { status: 'PENDING_VERIFICATION', public_key: null, wallet_address: signer.address } });
      const signature = await signer.signMessage(AgentsService.verificationMessage(agentId, ownerUserId));
      keys.add((await service.verifyAndIssueKey(ownerUserId, agentId, signature)).apiKey);
    }
    expect(keys.size).toBe(3);
  });
});
