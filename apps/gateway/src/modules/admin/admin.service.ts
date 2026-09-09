import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { prisma } from '@x402/database';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { approveMultisig, getMultisigConfig, proposeMultisig } from '../x402/multisig-client';

@Injectable()
export class AdminService {
  async getHealth() {
    return {
      status: 'ok' as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '0.1.0',
    };
  }

  /**
   * Gateway statistics scoped to the authenticated wallet's providers.
   * Unscoped global counts were a cross-tenant information leak.
   */
  async getStats(ownerAddress: string) {
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    const [providers, routes, payments, confirmedPayments] = await Promise.all([
      prisma.provider.count({ where: { walletAddress: ownerAddress } }),
      prisma.route.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({ where: { providerId: { in: providerIds } } }),
      prisma.payment.count({
        where: { providerId: { in: providerIds }, status: 'confirmed' },
      }),
    ]);

    return {
      providers,
      routes,
      totalPayments: payments,
      confirmedPayments,
      failedPayments: payments - confirmedPayments,
    };
  }

  /**
   * Resolve the provider IDs owned by the authenticated wallet. All audit
   * reads are scoped to this set — a wallet can never see another wallet's
   * audit entries.
   */
  private async getOwnedProviderIds(ownerAddress: string): Promise<string[]> {
    const providers = await prisma.provider.findMany({
      where: { walletAddress: ownerAddress },
      select: { id: true },
    });
    return providers.map((p: { id: string }) => p.id);
  }

  /**
   * Get audit logs belonging to the authenticated wallet's providers, with
   * pagination and filtering. Log entries are never leaked across wallets.
   */
  async getAuditLogs(
    ownerAddress: string,
    options: {
      page?: number;
      limit?: number;
      action?: string;
      entity?: string;
      providerId?: string;
    } = {},
  ): Promise<{
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 50;
    const { action, entity } = options;

    // Ownership gate first — never construct a query for a resource the
    // caller cannot touch (404 instead of 403 so provider IDs can't be probed).
    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (options.providerId && !providerIds.includes(options.providerId)) {
      throw new NotFoundException(`Provider ${options.providerId} not found`);
    }
    const where: Record<string, unknown> = options.providerId
      ? { providerId: options.providerId }
      : { providerId: { in: providerIds } };
    if (action) where.action = action;
    if (entity) where.entity = entity;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return { data: logs, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async writeAuditLog(data: {
    action: string;
    entity: string;
    entityId?: string;
    /** Provider the audit entry belongs to — used to scope reads to owners. */
    providerId?: string;
    actor?: string;
    details?: Record<string, unknown>;
    ip?: string;
  }) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.auditLog.create({ data: data as any });
  }

  /**
   * Expire pending payments whose quote window has passed. Called by the
   * hourly cleanup job — prevents unbounded accumulation of stale rows.
   * Returns the number of payments expired.
   */
  async expireStalePayments(quoteExpirySeconds: number): Promise<number> {
    const cutoff = new Date(Date.now() - quoteExpirySeconds * 1000);
    const result = await prisma.payment.updateMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      data: { status: 'expired' },
    });
    if (result.count > 0) {
      logger.info(`Expired ${result.count} stale pending payments`, { cutoff });
    }
    return result.count;
  }

  // ── Provider payouts (multisig automation) ──

  /**
   * Confirmed revenue for a provider that has NOT yet been paid out.
   *
   * Computed as: sum of confirmed `Payment.amount` − sum of amounts already
   * covered by executed payout proposals. Wallet-scoped: the caller must own
   * the provider (404 otherwise, so provider IDs can't be probed).
   */
  async getPendingPayoutAmount(providerId: string, ownerAddress: string): Promise<bigint> {
    const provider = await prisma.provider.findFirst({
      where: { id: providerId, walletAddress: ownerAddress },
      select: { id: true },
    });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);

    const [revenue, paidOut] = await Promise.all([
      prisma.payment.aggregate({
        where: { providerId, status: 'confirmed' },
        _sum: { amount: true },
      }),
      prisma.payoutProposal.aggregate({
        where: { providerId, status: 'executed' },
        _sum: { amount: true },
      }),
    ]);

    const total = revenue._sum.amount ?? 0n;
    const alreadyPaid = paidOut._sum.amount ?? 0n;
    return total - alreadyPaid;
  }

  /**
   * List payout proposals visible to the authenticated wallet.
   *
   * A wallet may only ever see proposals for providers it owns — proposals
   * belonging to another wallet's provider are never returned.
   */
  async listPayouts(
    ownerAddress: string,
    options: { page?: number; limit?: number; status?: string; providerId?: string } = {},
  ): Promise<{
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = options.page || 1;
    const limit = options.limit || 20;

    const providerIds = await this.getOwnedProviderIds(ownerAddress);
    if (options.providerId && !providerIds.includes(options.providerId)) {
      throw new NotFoundException(`Provider ${options.providerId} not found`);
    }

    const where: Record<string, unknown> = options.providerId
      ? { providerId: options.providerId }
      : { providerId: { in: providerIds } };
    if (options.status) where.status = options.status;

    const [rows, total] = await Promise.all([
      prisma.payoutProposal.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payoutProposal.count({ where }),
    ]);

    const data = rows.map((p: Record<string, any>) => ({
      id: p.id,
      providerId: p.providerId,
      proposalId: p.proposalId,
      destination: p.destination,
      amount: p.amount.toString(),
      asset: p.asset,
      status: p.status,
      approvals: p.approvals,
      threshold: p.threshold,
      txHash: p.txHash,
      error: p.error,
      executedAt: p.executedAt,
      createdAt: p.createdAt,
    }));

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Propose a provider payout through the multisig contract.
   *
   * Flow:
   *   1. Ownership gate: only the provider owner may propose a payout.
   *   2. Resolve the payout destination (provider.payoutWalletAddress).
   *   3. Compute the pending confirmed revenue unless an explicit amount was
   *      given (capped at pending revenue).
   *   4. When `payoutAutomationEnabled` is false the call fails cleanly with
   *      503 — no DB row, no contract call (the flag is the kill switch).
   *   5. Create the DB proposal row (status `pending`), then call
   *      multisig.propose on-chain. For threshold-1 wallets the gateway
   *      auto-approves (single signer is the whole quorum).
   */
  async proposePayout(
    ownerAddress: string,
    options: { providerId: string; amount?: string },
  ): Promise<Record<string, unknown>> {
    const config = getConfig();
    if (!config.payment.payoutAutomationEnabled) {
      throw new ServiceUnavailableException(
        'Payout automation is disabled (PAYOUT_AUTOMATION_ENABLED=false)',
      );
    }
    if (!config.payment.contractAdminSecret) {
      throw new ServiceUnavailableException(
        'Payout automation requires CONTRACT_ADMIN_SECRET to be configured',
      );
    }

    // Ownership gate + destination resolution in one query (404 keeps
    // provider IDs unprobeable).
    const provider = await prisma.provider.findFirst({
      where: { id: options.providerId, walletAddress: ownerAddress },
    });
    if (!provider) throw new NotFoundException(`Provider ${options.providerId} not found`);
    if (!provider.payoutWalletAddress) {
      throw new BadRequestException(
        `Provider ${options.providerId} has no payoutWalletAddress — set one before proposing a payout`,
      );
    }

    const pending = await this.getPendingPayoutAmount(options.providerId, ownerAddress);
    let amount = options.amount ? BigInt(options.amount) : pending;
    if (amount <= 0n) {
      throw new BadRequestException('No pending confirmed revenue to pay out');
    }
    if (amount > pending) {
      // Never propose more than what the ledger confirms — a malicious or
      // mistaken explicit amount cannot over-pay beyond earned revenue.
      amount = pending;
    }

    // 1. Persist the proposal first (source of truth for the dashboard).
    const row = await prisma.payoutProposal.create({
      data: {
        providerId: options.providerId,
        destination: provider.payoutWalletAddress,
        amount,
        asset: 'USDC',
        status: 'pending',
      },
    });

    // 2. Propose on-chain.
    const proposeResult = await proposeMultisig({
      contractId: config.contracts.multisig,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      timeoutSeconds: Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
      adminSecret: config.payment.contractAdminSecret,
      destination: provider.payoutWalletAddress,
      amount: amount.toString(),
    });

    if (!proposeResult.success) {
      await prisma.payoutProposal.update({
        where: { id: row.id },
        data: { status: 'failed', error: proposeResult.error?.slice(0, 500) },
      });
      throw new ServiceUnavailableException(
        `On-chain payout proposal failed: ${proposeResult.error}`,
      );
    }

    const updated = await prisma.payoutProposal.update({
      where: { id: row.id },
      data: { status: 'proposed', proposalId: proposeResult.proposalId ?? null },
    });

    // 3. Threshold-1 auto-approve: read the multisig config; if the wallet
    // needs a single signature, approve immediately (the single signer is the
    // whole quorum). Higher thresholds stay `proposed` for signer approval.
    const multisigConfig = await getMultisigConfig(
      config.contracts.multisig,
      config.stellar.sorobanRpcUrl,
      config.stellar.networkPassphrase,
      Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
    );

    if (multisigConfig && multisigConfig.threshold <= 1 && proposeResult.proposalId !== undefined) {
      const approved = await this.approvePayout(ownerAddress, updated.id);
      return {
        ...approved,
        autoApproved: true,
      };
    }

    return {
      id: updated.id,
      providerId: updated.providerId,
      proposalId: updated.proposalId,
      destination: updated.destination,
      amount: updated.amount.toString(),
      status: updated.status,
      autoApproved: false,
    };
  }

  /**
   * Approve a payout proposal as a multisig signer.
   *
   * The gateway signs with `CONTRACT_ADMIN_SECRET` (the operator's signer
   * key). The contract enforces that only a configured signer's key can
   * approve, so a non-signer admin secret fails on-chain and the proposal is
   * marked failed — never silently accepted.
   *
   * When the approval reaches the contract threshold the transfer executes
   * within the same contract call, and the proposal transitions to
   * `executed` (the revenue is now paid out).
   */
  async approvePayout(ownerAddress: string, payoutId: string): Promise<Record<string, unknown>> {
    const config = getConfig();
    if (!config.payment.payoutAutomationEnabled) {
      throw new ServiceUnavailableException(
        'Payout automation is disabled (PAYOUT_AUTOMATION_ENABLED=false)',
      );
    }
    if (!config.payment.contractAdminSecret) {
      throw new ServiceUnavailableException(
        'Payout automation requires CONTRACT_ADMIN_SECRET to be configured',
      );
    }

    // Ownership gate: the proposal must belong to a provider owned by the
    // caller (404 otherwise — ids stay unprobeable).
    const proposal = await prisma.payoutProposal.findFirst({
      where: { id: payoutId, provider: { walletAddress: ownerAddress } },
    });
    if (!proposal) throw new NotFoundException(`Payout proposal ${payoutId} not found`);

    if (proposal.status === 'executed' || proposal.status === 'failed') {
      throw new BadRequestException(`Payout proposal is already ${proposal.status}`);
    }
    if (proposal.proposalId === null) {
      throw new BadRequestException('Payout proposal has not been proposed on-chain yet');
    }

    const adminSecret = config.payment.contractAdminSecret;
    let adminAddress: string | null = null;
    try {
      adminAddress = Keypair.fromSecret(adminSecret).publicKey();
    } catch {
      // Invalid secret — the on-chain call below will fail with a clear error.
    }

    const approveResult = await approveMultisig({
      contractId: config.contracts.multisig,
      rpcUrl: config.stellar.sorobanRpcUrl,
      networkPassphrase: config.stellar.networkPassphrase,
      timeoutSeconds: Math.ceil(config.stellar.sorobanRpcTimeoutMs / 1000),
      signerSecret: adminSecret,
      signer: adminAddress || '',
      proposalId: proposal.proposalId,
    });

    if (!approveResult.success) {
      await prisma.payoutProposal.update({
        where: { id: payoutId },
        data: { status: 'failed', error: approveResult.error?.slice(0, 500) },
      });
      throw new ServiceUnavailableException(
        `On-chain payout approval failed: ${approveResult.error}`,
      );
    }

    const approvals = Array.isArray(proposal.approvals)
      ? [...(proposal.approvals as string[])]
      : [];
    if (adminAddress && !approvals.includes(adminAddress)) {
      approvals.push(adminAddress);
    }

    const executed = approveResult.executed === true;
    const updated = await prisma.payoutProposal.update({
      where: { id: payoutId },
      data: {
        status: executed ? 'executed' : 'approved',
        approvals,
        executedAt: executed ? new Date() : null,
        error: null,
      },
    });

    logger.info('[payouts] Payout proposal updated', {
      payoutId,
      proposalId: proposal.proposalId,
      status: updated.status,
      executed,
    });

    return {
      id: updated.id,
      providerId: updated.providerId,
      proposalId: updated.proposalId,
      destination: updated.destination,
      amount: updated.amount.toString(),
      status: updated.status,
      approvals,
      executed,
    };
  }
}
