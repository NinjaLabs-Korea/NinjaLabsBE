import { createHash } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
import { withParamsCheck } from '../test-support/expect-params-match';
import { AgentApiKeyService } from './agent-api-key.service';

describe('AgentApiKeyService', () => {
  const rawKey = 'nj_1234567890abcdefghijklmnopqrstuvwxyz';
  const future = '2099-01-01T00:00:00.000Z';

  function row(overrides: Record<string, unknown> = {}) {
    return {
      api_key_id: '11111111-1111-4111-8111-111111111111',
      key_hash: createHash('sha256').update(rawKey).digest('hex'),
      key_status: 'ACTIVE',
      expires_at: future,
      agent_id: '22222222-2222-4222-8222-222222222222',
      owner_user_id: '33333333-3333-4333-8333-333333333333',
      agent_name: 'market-agent',
      wallet_address: '0x1111111111111111111111111111111111111111',
      agent_status: 'ACTIVE',
      ...overrides,
    };
  }

  function createService(candidates: Record<string, unknown>[], touchRowCount = 1) {
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: candidates.length, rows: candidates })
      .mockResolvedValueOnce({
        rowCount: touchRowCount,
        rows: touchRowCount ? [{ id: 'key-id' }] : [],
      });
    // Both statements (prefix lookup, conditional last_used_at UPDATE) are checked for $n/params drift on every call.
    const db = { query: withParamsCheck(txQuery), tx: jest.fn() };
    return {
      service: new AgentApiKeyService(db as unknown as DatabaseService),
      db,
      txQuery,
    };
  }

  it('authenticates an active unexpired key and records its use', async () => {
    const { service, txQuery } = createService([row()]);

    await expect(service.authenticate(rawKey)).resolves.toEqual({
      agentId: '22222222-2222-4222-8222-222222222222',
      ownerUserId: '33333333-3333-4333-8333-333333333333',
      name: 'market-agent',
      walletAddress: '0x1111111111111111111111111111111111111111',
      apiKeyId: '11111111-1111-4111-8111-111111111111',
    });
    expect(txQuery).toHaveBeenCalledTimes(2);
    expect(txQuery.mock.calls[1][1]).toEqual([
      '11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('takes no row lock and opens no transaction: a plain lookup plus a conditional last_used_at UPDATE', async () => {
    const { service, db, txQuery } = createService([row()]);
    await service.authenticate(rawKey);
    expect(db.tx).not.toHaveBeenCalled();
    const [lookup, touch] = txQuery.mock.calls.map(([sql]) => sql as string);
    expect(lookup).not.toContain('FOR UPDATE');
    expect(lookup).toContain('a.deleted_at IS NULL');
    // the owner must be an active, undeleted account (a suspended owner's agents stop with them)
    expect(lookup).toContain('JOIN "user" u ON u.id = a.owner_user_id');
    expect(lookup).toContain("u.status = 'ACTIVE' AND u.deleted_at IS NULL");
    expect(touch).toContain('UPDATE agent_api_key');
    expect(touch).toContain("WHERE id = $1 AND status = 'ACTIVE' AND expires_at > now()");
    expect(touch).not.toMatch(/UPDATE agent\b/);
  });

  it('checks every key sharing the same lookup prefix', async () => {
    const differentHash = createHash('sha256').update(`${rawKey}-other`).digest('hex');
    const { service } = createService([
      row({
        api_key_id: '44444444-4444-4444-8444-444444444444',
        key_hash: differentHash,
      }),
      row(),
    ]);

    await expect(service.authenticate(rawKey)).resolves.toMatchObject({
      agentId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it.each([
    ['revoked key', { key_status: 'REVOKED' }],
    ['expired key', { expires_at: '2000-01-01T00:00:00.000Z' }],
    ['key without expiry', { expires_at: null }],
    ['inactive agent', { agent_status: 'SUSPENDED' }],
  ])('rejects an invalid credential state: %s', async (_label, overrides) => {
    const { service, txQuery } = createService([row(overrides)]);

    await expect(service.authenticate(rawKey)).rejects.toMatchObject({
      message: 'INVALID_AGENT_API_KEY',
    });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects a key whose hash does not match the prefix candidates', async () => {
    const differentHash = createHash('sha256').update(`${rawKey}-other`).digest('hex');
    const { service, txQuery } = createService([row({ key_hash: differentHash })]);

    await expect(service.authenticate(rawKey)).rejects.toMatchObject({
      message: 'INVALID_AGENT_API_KEY',
    });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects a key revoked between verification and last-used update', async () => {
    const { service } = createService([row()], 0);

    await expect(service.authenticate(rawKey)).rejects.toMatchObject({
      message: 'INVALID_AGENT_API_KEY',
    });
  });

  it('rejects malformed keys before querying the database', async () => {
    const { service, txQuery } = createService([]);

    await expect(service.authenticate('invalid')).rejects.toMatchObject({
      message: 'INVALID_AGENT_API_KEY',
    });
    expect(txQuery).not.toHaveBeenCalled();
  });
  it('looks candidates up by the first 11 characters of the presented key only (nj_ + 8), never by the full key or its hash', async () => {
    const { service, txQuery } = createService([row()]);
    await service.authenticate(rawKey);
    expect(txQuery.mock.calls[0][1]).toEqual(['nj_12345678']);
    expect(JSON.stringify(txQuery.mock.calls)).not.toContain(rawKey);
  });

  it.each([
    ['a key without the nj_ marker', 'sk_1234567890abcdefghijklmnop'],
    ['an nj_ key shorter than 16 characters', 'nj_123456789012'],
    ['the marker in the wrong case', 'NJ_1234567890abcdefghijklmnop'],
  ])('rejects %s with 401 INVALID_AGENT_API_KEY without a lookup', async (_label, key) => {
    const { service, txQuery } = createService([row()]);
    await expect(service.authenticate(key)).rejects.toMatchObject({ status: 401, message: 'INVALID_AGENT_API_KEY' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('skips a candidate whose stored hash is not 64 hex characters (corrupt row) instead of throwing, and still matches the valid one', async () => {
    const { service } = createService([
      row({ api_key_id: 'corrupt', key_hash: 'zz'.repeat(32) }),
      row({ api_key_id: 'short', key_hash: 'abcd' }),
      row(),
    ]);
    await expect(service.authenticate(rawKey)).resolves.toMatchObject({ apiKeyId: '11111111-1111-4111-8111-111111111111' });
  });

  it('rejects an unparseable expires_at as expired', async () => {
    const { service, txQuery } = createService([row({ expires_at: 'not-a-date' })]);
    await expect(service.authenticate(rawKey)).rejects.toMatchObject({ message: 'INVALID_AGENT_API_KEY' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('accepts a key expiring one minute from now and rejects one that expired a second ago (expiry boundary)', async () => {
    const soon = createService([row({ expires_at: new Date(Date.now() + 60_000) })]);
    await expect(soon.service.authenticate(rawKey)).resolves.toMatchObject({ agentId: '22222222-2222-4222-8222-222222222222' });
    const past = createService([row({ expires_at: new Date(Date.now() - 1_000) })]);
    await expect(past.service.authenticate(rawKey)).rejects.toMatchObject({ message: 'INVALID_AGENT_API_KEY' });
  });
});
