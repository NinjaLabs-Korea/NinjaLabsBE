import { createHash } from 'crypto';
import { DatabaseService } from '../common/database/database.service';
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
    const db = {
      tx: jest.fn(async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
        callback({ query: txQuery })),
    };
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
    const { service, db } = createService([]);

    await expect(service.authenticate('invalid')).rejects.toMatchObject({
      message: 'INVALID_AGENT_API_KEY',
    });
    expect(db.tx).not.toHaveBeenCalled();
  });
});
