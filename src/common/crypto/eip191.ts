import { getAddress, verifyMessage } from 'ethers';

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
