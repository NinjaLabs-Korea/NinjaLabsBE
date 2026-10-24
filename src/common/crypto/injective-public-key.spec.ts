import { Wallet } from 'ethers';
import { getInjectiveAddress } from '../../test-e2e/support/injective-sdk.stub';
import { injectivePublicKeyMatchesAddress } from './injective-public-key';

// sdk-ts is ESM-only: the e2e stub implements getEthereumAddress with real bech32 (byte-identical to sdk-ts, platform.e2e-spec vectors)
jest.mock('@injectivelabs/sdk-ts', () => jest.requireActual('../../test-e2e/support/injective-sdk.stub'));

const b64 = (hex: string) => Buffer.from(hex.replace(/^0x/, ''), 'hex').toString('base64');

describe('injectivePublicKeyMatchesAddress', () => {
  const signer = Wallet.createRandom();
  const address = getInjectiveAddress(signer.address);

  it("accepts the wallet's own compressed key (Keplr pub_key.value, base64)", () => {
    expect(injectivePublicKeyMatchesAddress(address, b64(signer.signingKey.compressedPublicKey))).toBe(true);
  });

  it.each([
    ["another wallet's key", () => b64(Wallet.createRandom().signingKey.compressedPublicKey)],
    ['the uncompressed form of the right key (65 bytes)', () => b64(signer.signingKey.publicKey)],
    ['a hex string instead of base64', () => signer.signingKey.compressedPublicKey],
    ['33 bytes that are not a curve point', () => b64(`02${'ff'.repeat(32)}`)],
    ['an empty string', () => ''],
  ])('rejects %s', (_label, key) => {
    expect(injectivePublicKeyMatchesAddress(address, key())).toBe(false);
  });

  it('rejects (never throws on) a malformed or non-inj address', () => {
    const key = b64(signer.signingKey.compressedPublicKey);
    expect(injectivePublicKeyMatchesAddress(`${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`, key)).toBe(false);
    expect(injectivePublicKeyMatchesAddress('inj1abc', key)).toBe(false);
    expect(injectivePublicKeyMatchesAddress(getInjectiveAddress(Wallet.createRandom().address), key)).toBe(false);
  });
});
