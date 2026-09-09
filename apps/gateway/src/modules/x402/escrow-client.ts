/**
 * Soroban contract client for the credit-escrow contract.
 *
 * Enables per-token metered billing: after each LLM response the gateway
 * charges the actual cost from the caller's escrow balance and auto-refunds
 * any surplus. All contract interactions are best-effort — failures are
 * logged but never block the LLM response from reaching the caller.
 *
 * Requires `CONTRACT_ADMIN_SECRET` and `ESCROW_SETTLEMENT_ENABLED=true`.
 */

import { xdr, Keypair } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';
import { accountAddressToScVal, amountToScVal } from './soroban-utils';

// ── Public API ───────────────────────────────

export interface EscrowChargeOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** RPC timeout in seconds (passed to the stellar-sdk contract client). */
  timeoutSeconds?: number;
  /** Secret key of the contract admin (signs the invocation). */
  adminSecret: string;
  /** Stellar address of the user whose escrow balance to charge. */
  user: string;
  /** Amount to charge in stroops. */
  amount: string;
  /** Quote ID for idempotency (same quote never charged twice). */
  quoteId: string;
}

export interface EscrowRefundOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** RPC timeout in seconds (passed to the stellar-sdk contract client). */
  timeoutSeconds?: number;
  adminSecret: string;
  user: string;
  /** Amount to refund in stroops (the surplus). */
  amount: string;
  /** Quote ID for idempotency (same quote never refunded twice). */
  quoteId: string;
}

export interface EscrowResult {
  success: boolean;
  error?: string;
}

// ── Core Operations ───────────────────────────

/**
 * Charge a user's escrow balance for actual LLM usage.
 *
 * Idempotent per (user, quoteId): the contract's `charge()` function uses a
 * `(CHARGED, user, quote_id)` guard so a retried settlement call can never
 * double-deduct.
 */
export async function chargeEscrow(options: EscrowChargeOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      ...(options.timeoutSeconds ? { timeout: options.timeoutSeconds } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.charge({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[escrow] Charge settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
    });
    return { success: true };
  } catch (err) {
    // Best-effort: escrow settlement must never block the LLM response.
    const message = (err as Error).message;
    logger.warn(
      `[escrow] chargeEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain settlement. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Refund a surplus back to a user's escrow balance.
 *
 * Idempotent per (user, quoteId): the contract's `refund()` function uses a
 * `(REFUNDED, user, quote_id)` guard so a retried refund can never double-pay.
 */
export async function refundEscrow(options: EscrowRefundOptions): Promise<EscrowResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, user, amount, quoteId } = options;

  try {
    const adminKeypair = Keypair.fromSecret(adminSecret);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      ...(options.timeoutSeconds ? { timeout: options.timeoutSeconds } : {}),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await client.refund({
      user: accountAddressToScVal(user),
      amount: amountToScVal(amount),
      quote_id: xdr.ScVal.scvString(quoteId),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    logger.info('[escrow] Refund settled on-chain', {
      user: user.slice(0, 8),
      amount,
      quoteId: quoteId.slice(0, 8),
    });
    return { success: true };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[escrow] refundEscrow failed for user ${user.slice(0, 8)}... — ` +
        `skipping on-chain refund. Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Full settlement: charge actual cost from escrow, then refund any surplus.
 *
 * This is the high-level entry point wired into `applyMeteredPricing()`. It
 * gates on `escrowSettlementEnabled` and `contractAdminSecret` — if either is
 * missing the call is a silent no-op so the feature can be configured but not
 * active in every deployment.
 */
export async function settleEscrow(options: {
  enabled: boolean;
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  adminSecret?: string;
  user: string;
  actualCost: string;
  surplus: string;
  isOverpaid: boolean;
  quoteId: string;
}): Promise<void> {
  if (!options.enabled || !options.adminSecret) return;

  const {
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    actualCost,
    surplus,
    isOverpaid,
    quoteId,
  } = options;

  // Charge the actual cost from the user's escrow balance.
  // Idempotent — retrying the same quote never double-charges.
  const chargeResult = await chargeEscrow({
    contractId,
    rpcUrl,
    networkPassphrase,
    adminSecret,
    user,
    amount: actualCost,
    quoteId,
  });

  if (!chargeResult.success) {
    logger.warn('[escrow] Charge failed, skipping refund', {
      user: user.slice(0, 8),
      actualCost,
      error: chargeResult.error,
    });
    return;
  }

  // Refund surplus when the caller overpaid (per-token deposit > actual cost).
  if (isOverpaid && BigInt(surplus) > 0n) {
    await refundEscrow({
      contractId,
      rpcUrl,
      networkPassphrase,
      adminSecret,
      user,
      amount: surplus,
      quoteId,
    });
  }
}
