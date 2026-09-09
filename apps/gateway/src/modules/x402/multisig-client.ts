/**
 * Soroban contract client for the multisig wallet contract.
 *
 * Enables provider payout automation: the gateway proposes payouts of
 * confirmed provider revenue through the multisig wallet, and signers approve
 * them until the M-of-N threshold is reached (at which point the contract
 * executes the transfer itself).
 *
 * All contract interactions are best-effort — failures are surfaced as
 * `{ success: false, error }` results and never crash the gateway.
 *
 * Requires `CONTRACT_ADMIN_SECRET` (fee payer / proposer) and, for approval,
 * the signer's secret key (the contract enforces `signer.require_auth()`).
 */

import { xdr, Keypair, Address } from '@stellar/stellar-sdk';
import { logger } from '@x402/logger';
import { accountAddressToScVal, amountToScVal } from './soroban-utils';

// ── Public types ─────────────────────────────

export interface MultisigProposeOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** RPC timeout in seconds (passed to the stellar-sdk contract client). */
  timeoutSeconds?: number;
  /** Secret key of the fee payer / proposer (e.g. the contract admin). */
  adminSecret: string;
  /** Destination Stellar address the payout would transfer to. */
  destination: string;
  /** Amount to propose in stroops (i128). */
  amount: string;
}

export interface MultisigApproveOptions {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  timeoutSeconds?: number;
  /** Secret key of the approving signer (must be a configured multisig signer). */
  signerSecret: string;
  /** The signer's public address (used for the on-chain auth entry). */
  signer: string;
  /** On-chain proposal id returned by `propose`. */
  proposalId: number;
}

export interface MultisigProposalInfo {
  id: number;
  destination: string;
  amount: string;
  executed: boolean;
  approvals: string[];
  createdAt: number;
}

export interface MultisigConfigInfo {
  signers: string[];
  threshold: number;
  token: string;
}

export interface MultisigResult {
  success: boolean;
  error?: string;
  /** Set by `propose` — the on-chain proposal id. */
  proposalId?: number;
  /** Set by `approve` — whether the proposal reached quorum and executed. */
  executed?: boolean;
}

// ── Core operations ──────────────────────────

/**
 * Propose a payout on the multisig contract.
 *
 * `propose` requires no signer auth — anyone may propose; execution is gated
 * by the M-of-N approvals. The admin keypair signs the envelope as fee payer.
 */
export async function proposeMultisig(options: MultisigProposeOptions): Promise<MultisigResult> {
  const { contractId, rpcUrl, networkPassphrase, adminSecret, destination, amount } = options;

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
    const tx: any = await client.propose({
      destination: accountAddressToScVal(destination),
      amount: amountToScVal(amount),
    });

    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(adminKeypair);
    }
    tx.sign(adminKeypair);
    await tx.send();

    // The proposal id is the parsed return value of the invocation.
    const proposalId = Number(tx.result ?? 0);

    logger.info('[multisig] Payout proposed on-chain', {
      contractId: contractId.slice(0, 8),
      destination: destination.slice(0, 8),
      amount,
      proposalId,
    });
    return { success: true, proposalId };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(
      `[multisig] proposeMultisig failed for destination ${destination.slice(0, 8)}... — ` +
        `Error: ${message}`,
    );
    return { success: false, error: message };
  }
}

/**
 * Approve a payout proposal on the multisig contract as a signer.
 *
 * The contract enforces `signer.require_auth()`: only a configured signer
 * whose key actually signs this invocation can approve. When the approval
 * count reaches the threshold the contract executes the transfer in the same
 * call, so `executed` reflects the post-call state.
 */
export async function approveMultisig(options: MultisigApproveOptions): Promise<MultisigResult> {
  const { contractId, rpcUrl, networkPassphrase, signerSecret, signer, proposalId } = options;

  try {
    const signerKeypair = Keypair.fromSecret(signerSecret);

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
    const tx: any = await client.approve({
      signer: accountAddressToScVal(signer),
      proposal_id: xdr.ScVal.scvU32(proposalId),
    });

    // The auth entry for `signer.require_auth()` is created by the SDK during
    // simulation; signing it with the signer's key proves authorization.
    if (typeof tx.signAuthEntries === 'function') {
      tx.signAuthEntries(signerKeypair);
    }
    tx.sign(signerKeypair);
    await tx.send();

    const executed = Boolean(tx.result);

    logger.info('[multisig] Payout approval submitted', {
      contractId: contractId.slice(0, 8),
      proposalId,
      signer: signer.slice(0, 8),
      executed,
    });
    return { success: true, executed };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`[multisig] approveMultisig failed for proposal ${proposalId} — Error: ${message}`);
    return { success: false, error: message };
  }
}

// ── Reads (best-effort, never crash) ─────────

/**
 * Fetch the multisig config (signers, threshold, token). Best-effort read —
 * failures return `null` so callers can degrade gracefully.
 */
export async function getMultisigConfig(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
  timeoutSeconds = 10,
): Promise<MultisigConfigInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      ...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
    });

    // Read-only invocation — the client returns `{ result }` after simulation.
    const { result } = await client.get_config();

    return {
      signers: Array.isArray(result.signers)
        ? result.signers.map((s: string) => Address.fromString(s).toString())
        : [],
      threshold: Number(result.threshold ?? 0),
      token: result.token ? Address.fromString(result.token).toString() : '',
    };
  } catch (err) {
    logger.warn(
      `[multisig] getMultisigConfig failed for contract ${contractId.slice(0, 8)}... — ` +
        `Error: ${(err as Error).message}`,
    );
    return null;
  }
}

/**
 * Fetch a single proposal from the multisig contract. Best-effort read —
 * failures return `null`.
 */
export async function getMultisigProposal(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
  proposalId: number,
  timeoutSeconds = 10,
): Promise<MultisigProposalInfo | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { contract } = await import('@stellar/stellar-sdk');
    const { Client } = contract;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = await Client.from({
      contractId,
      rpcUrl,
      networkPassphrase,
      ...(timeoutSeconds ? { timeout: timeoutSeconds } : {}),
    });

    const { result } = await client.get_proposal({ proposal_id: xdr.ScVal.scvU32(proposalId) });

    return {
      id: Number(result.id ?? proposalId),
      destination: Address.fromString(result.destination).toString(),
      amount: String(result.amount ?? 0),
      executed: Boolean(result.executed),
      approvals: Array.isArray(result.approvals)
        ? result.approvals.map((a: string) => Address.fromString(a).toString())
        : [],
      createdAt: Number(result.createdAt ?? 0),
    };
  } catch (err) {
    logger.warn(
      `[multisig] getMultisigProposal failed for proposal ${proposalId} — ` +
        `Error: ${(err as Error).message}`,
    );
    return null;
  }
}
