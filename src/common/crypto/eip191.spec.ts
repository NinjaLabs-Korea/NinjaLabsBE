import { computeAddress, Wallet } from 'ethers';
import { recoverEip191PublicKey, verifyEip191Signature } from './eip191';

describe('verifyEip191Signature', () => {
  it('accepts a personal_sign signature from the claimed address', async () => {
    const wallet = Wallet.createRandom();
    const message = 'NinjaLabs wallet challenge';
    const signature = await wallet.signMessage(message);

    expect(verifyEip191Signature(wallet.address, message, signature)).toBe(true);
    expect(verifyEip191Signature(wallet.address.toLowerCase(), message, signature)).toBe(true);
  });

  it('rejects a signature from a different address and malformed input', async () => {
    const signer = Wallet.createRandom();
    const other = Wallet.createRandom();
    const signature = await signer.signMessage('challenge');

    expect(verifyEip191Signature(other.address, 'challenge', signature)).toBe(false);
    expect(verifyEip191Signature(signer.address, 'challenge', 'not-a-signature')).toBe(false);
  });

  it('recovers the compressed public key only for the claimed signer', async () => {
    const signer = Wallet.createRandom();
    const message = 'NinjaLabs agent registration';
    const signature = await signer.signMessage(message);
    const publicKey = recoverEip191PublicKey(signer.address, message, signature);

    expect(publicKey).toMatch(/^0x0[23][0-9a-f]{64}$/i);
    expect(computeAddress(publicKey!)).toBe(signer.address);
    expect(recoverEip191PublicKey(Wallet.createRandom().address, message, signature)).toBeNull();
  });
});
