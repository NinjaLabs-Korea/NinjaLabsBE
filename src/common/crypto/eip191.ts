import { getAddress, hashMessage, Signature, SigningKey, verifyMessage } from 'ethers';

/** EIP-191 personal_sign verification for Injective EVM wallets. */
export function verifyEip191Signature(
  address: string,
  message: string,
  signature: string,
): boolean {
  try {
    return getAddress(verifyMessage(message, signature)) === getAddress(address);
  } catch {
    return false;
  }
}

/** Verify an EIP-191 signature and return its compressed secp256k1 public key. */
export function recoverEip191PublicKey(
  address: string,
  message: string,
  signature: string,
): string | null {
  try {
    if (getAddress(verifyMessage(message, signature)) !== getAddress(address)) return null;
    const publicKey = SigningKey.recoverPublicKey(hashMessage(message), Signature.from(signature));
    return SigningKey.computePublicKey(publicKey, true);
  } catch {
    return null;
  }
}
