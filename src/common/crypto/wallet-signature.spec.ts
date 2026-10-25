import { Wallet } from 'ethers';
import { signatureSchemeFor } from './wallet-signature';

// jest.mock 팩토리는 호이스팅되므로 `mock` 접두사 상수만 참조할 수 있다
const mockAdr36Key = 'AqurqurqurqurqurqurqurqurqurqurqurqurqurqurqG'.slice(0, 44); // 33바이트로 디코딩되는 44자
jest.mock('./adr36', () => ({
  verifyAdr36Signature: jest.fn((_address: string, _message: string, publicKey: string) => publicKey === 'valid-key' || publicKey.startsWith(mockAdr36Key)),
}));

describe('signatureSchemeFor', () => {
  it('ADR-36 returns the canonical key spelling, never the raw client string (it is what gets stored)', () => {
    const scheme = signatureSchemeFor('inj1example');
    const padded = `${mockAdr36Key}\n${'!'.repeat(5000)}`;
    const verified = scheme.verify({ address: 'inj1example', message: 'm', signature: 's', publicKey: padded });
    expect(verified).toEqual({ publicKey: Buffer.from(mockAdr36Key, 'base64').toString('base64') });
    expect(verified?.publicKey).toHaveLength(44);
  });

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
