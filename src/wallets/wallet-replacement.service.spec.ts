import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { createMockDb } from '../test-support/mock-db';
import { WalletReplacementService } from './wallet-replacement.service';

jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../test-e2e/support/injective-sdk.stub'));
jest.mock('../common/crypto/adr36', () => ({ verifyAdr36Signature: jest.fn(() => false) }));

describe('receiving wallet rollout gate', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'tru'])('fails closed for %s before any database work', async (value) => {
    const mock = createMockDb({ strict: true });
    const config = { get: () => value } as unknown as ConfigService;
    const service = new WalletReplacementService(mock.database, new AuditService(mock.database), config);
    await expect(service.createChallenge('user', 'old', 'new')).rejects.toMatchObject({ status: 503, message: 'WALLET_CHANGE_DISABLED' });
    await expect(service.verify('user', { challengeId: 'id', currentSignature: 'old', newSignature: 'new' })).rejects.toMatchObject({ status: 503, message: 'WALLET_CHANGE_DISABLED' });
    expect(mock.db.tx).not.toHaveBeenCalled();
    expect(mock.db.query).not.toHaveBeenCalled();
  });
});
