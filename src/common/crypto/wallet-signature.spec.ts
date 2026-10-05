import { Wallet } from 'ethers';
import { signatureSchemeFor } from './wallet-signature';

jest.mock('./adr36', () => ({
  verifyAdr36Signature: jest.fn((_address: string, _message: string, publicKey: string) => publicKey === 'valid-key'),
}));

describe('signatureSchemeFor', () => {
  it('verifies EVM personal_sign and recovers the public key', async () => {
    const signer = Wallet.createRandom();
    const signature = await signer.signMessage('hello');
    const scheme = signatureSchemeFor(signer.address);

    expect(scheme.kind).toBe('EVM');
    expect(scheme.verify({ address: signer.address, message: 'hello', signature })).toEqual({
      publicKey: signer.signingKey.compressedPublicKey,
    });
    expect(scheme.verify({ address: signer.address, message: 'tampered', signature })).toBeNull();
  });

  it('requires a public key for ADR-36 wallets', () => {
    const scheme = signatureSchemeFor('inj1example');

    expect(scheme.kind).toBe('INJECTIVE');
    expect(scheme.verify({ address: 'inj1example', message: 'm', signature: 's' })).toBeNull();
    expect(scheme.verify({ address: 'inj1example', message: 'm', signature: 's', publicKey: 'valid-key' })).toEqual({
      publicKey: 'valid-key',
    });
  });
});
