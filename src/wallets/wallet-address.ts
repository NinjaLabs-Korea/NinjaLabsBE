import { BadRequestException } from '@nestjs/common';
import { getEthereumAddress, getInjectiveAddress } from '@injectivelabs/sdk-ts';
import { getAddress } from 'ethers';
import { isEvmAddress } from '../common/crypto/wallet-signature';

/** Signing addresses retain their scheme; persisted account addresses are always inj1. */
export function normalizeWalletAddress(address: string): string {
  const value = address.trim();
  try {
    if (isEvmAddress(value)) return getAddress(value);
    if (value.startsWith('inj1')) return getInjectiveAddress(getEthereumAddress(value));
  } catch { /* Invalid addresses use the same public error for either scheme. */ }
  throw new BadRequestException('INVALID_INJECTIVE_ADDRESS');
}

export function injectiveWalletAddress(address: string): string {
  return isEvmAddress(address) ? getInjectiveAddress(address) : address;
}

export function sameWalletAccount(address: string, injectiveAddress: string): boolean {
  try { return injectiveWalletAddress(address).toLowerCase() === injectiveAddress.toLowerCase(); }
  catch { return false; }
}
