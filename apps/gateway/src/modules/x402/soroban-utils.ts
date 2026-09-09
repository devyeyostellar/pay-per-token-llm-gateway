/**
 * Shared Soroban ScVal conversion helpers used by both the payment-verifier
 * contract client and the credit-escrow contract client.
 */

import { Address, xdr } from '@stellar/stellar-sdk';

/**
 * Convert a Stellar account (G...) or contract (C...) address to an
 * `Address` ScVal. `Address.fromString` accepts both forms in stellar-sdk
 * v12 (the raw-ed25519 workaround was only needed for older SDK versions).
 */
export function accountAddressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Convert a non-negative stroop amount (i128) to a signed 128-bit ScVal. */
export function amountToScVal(amount: string): xdr.ScVal {
  const value = BigInt(amount);
  if (value < 0n) throw new Error('Amount must be non-negative');
  const lo = xdr.Uint64.fromString(value.toString());
  const hi = xdr.Int64.fromString('0');
  return xdr.ScVal.scvI128(new xdr.Int128Parts({ lo, hi }));
}
