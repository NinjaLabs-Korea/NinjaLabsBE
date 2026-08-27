import { computeAddress, Wallet } from 'ethers';
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
    const service = new TestAgentsService(db as unknown as DatabaseService);
    return { db, service };
  }

  it('registers a dedicated 0x wallet without a public key, then recovers it on verify', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    db.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: agentId }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            status: 'PENDING_VERIFICATION',
            public_key: null,
            wallet_address: signer.address,
          },
        ],
      });
    const txQuery = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ expires_at: '2026-12-01T00:00:00.000Z' }],
      });
    db.tx.mockImplementation(
      async (callback: (tx: { query: typeof txQuery }) => Promise<unknown>) =>
        callback({ query: txQuery }),
    );

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
    expect(db.query.mock.calls[0][1]).toEqual([
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
    const recoveredPublicKey = txQuery.mock.calls[0][1][1] as string;
    expect(computeAddress(recoveredPublicKey)).toBe(signer.address);
  });

  it('returns the existing pending challenge after a rejected signature retry', async () => {
    const { db, service } = createService();
    const signer = Wallet.createRandom();
    db.query
      .mockRejectedValueOnce({ code: '23505' })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: agentId }] });

    await expect(
      service.register(ownerUserId, 'market-agent', undefined, undefined, signer.address),
    ).resolves.toEqual({
      agentId,
      status: 'PENDING_VERIFICATION',
      verificationMessage: AgentsService.verificationMessage(agentId, ownerUserId),
    });
  });

  it('rejects a signature from a different EVM key', async () => {
    const { db, service } = createService();
    const registered = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    db.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [
        {
          status: 'PENDING_VERIFICATION',
          public_key: null,
          wallet_address: registered.address,
        },
      ],
    });
    const signature = await attacker.signMessage(
      AgentsService.verificationMessage(agentId, ownerUserId),
    );

    await expect(service.verifyAndIssueKey(ownerUserId, agentId, signature)).rejects.toMatchObject({
      message: 'INVALID_SIGNATURE',
    });
    expect(db.tx).not.toHaveBeenCalled();
  });
});
