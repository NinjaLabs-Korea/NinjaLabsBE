import { Wallet } from 'ethers';
import { verifyEip191Signature } from './eip191';

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
});
