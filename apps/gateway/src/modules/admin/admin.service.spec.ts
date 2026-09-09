/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { loadConfig, setConfig } from '@x402/config';

jest.mock('@x402/database', () => ({
  prisma: {
    provider: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    route: {
      count: jest.fn(),
    },
    payment: {
      count: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn(),
    },
    auditLog: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    payoutProposal: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      aggregate: jest.fn(),
    },
  },
}));

// Mock the multisig contract client so payout tests never touch the network.
jest.mock('../x402/multisig-client', () => ({
  proposeMultisig: jest.fn(),
  approveMultisig: jest.fn(),
  getMultisigConfig: jest.fn(),
}));

const mockPrisma = jest.requireMock('@x402/database').prisma as any;
const mockProposeMultisig = jest.requireMock('../x402/multisig-client')
  .proposeMultisig as jest.Mock;
const mockApproveMultisig = jest.requireMock('../x402/multisig-client')
  .approveMultisig as jest.Mock;
const mockGetMultisigConfig = jest.requireMock('../x402/multisig-client')
  .getMultisigConfig as jest.Mock;

const OWNER = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

describe('AdminService', () => {
  let service: AdminService;

  // Config snapshot so tests can restore it after overriding payout flags.
  const baseConfig = loadConfig();

  beforeEach(() => {
    // resetAllMocks (not just clear) so mockResolvedValueOnce queues from one
    // test never leak into the next.
    jest.resetAllMocks();
    service = new AdminService();

    // Default: payout automation enabled with an admin secret so the
    // happy-path tests exercise the real orchestration flow.
    setConfig({
      ...baseConfig,
      payment: {
        ...baseConfig.payment,
        payoutAutomationEnabled: true,
        contractAdminSecret: 'SADMIN1234567890ADMIN1234567890ADMIN1234567890ADMIN12',
      },
    });
  });

  afterEach(() => {
    setConfig(baseConfig);
  });

  describe('getAuditLogs', () => {
    it("scopes audit reads to the owner's providers", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([
        { id: 'provider-1' },
        { id: 'provider-2' },
      ]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(0);

      const result = await service.getAuditLogs(OWNER, { page: 1, limit: 20 });

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { providerId: { in: ['provider-1', 'provider-2'] } },
          skip: 0,
          take: 20,
        }),
      );
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });

    it('applies action/entity filters alongside provider scoping', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([{ id: 'log-1' }]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(1);

      const result = await service.getAuditLogs(OWNER, {
        action: 'payment_verified',
        entity: 'payment',
        page: 2,
        limit: 10,
      });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            providerId: { in: ['provider-1'] },
            action: 'payment_verified',
            entity: 'payment',
          },
          skip: 10,
          take: 10,
        }),
      );
      expect(result.totalPages).toBe(1);
    });

    it('filters by an owned providerId', async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
      (mockPrisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);
      (mockPrisma.auditLog.count as jest.Mock).mockResolvedValue(0);

      await service.getAuditLogs(OWNER, { providerId: 'provider-1' });

      expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { providerId: 'provider-1' } }),
      );
    });

    it("throws NotFoundException for another wallet's provider", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);

      await expect(service.getAuditLogs(OWNER, { providerId: 'provider-other' })).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.auditLog.count).not.toHaveBeenCalled();
    });
  });

  describe('getStats (wallet-scoped)', () => {
    it("scopes statistics to the authenticated wallet's providers", async () => {
      (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([
        { id: 'provider-1' },
        { id: 'provider-2' },
      ]);
      (mockPrisma.provider.count as jest.Mock).mockResolvedValue(2);
      (mockPrisma.route.count as jest.Mock).mockResolvedValue(3);
      (mockPrisma.payment.count as jest.Mock)
        .mockResolvedValueOnce(10) // total
        .mockResolvedValueOnce(7); // confirmed

      const stats = await service.getStats(OWNER);

      expect(mockPrisma.provider.findMany).toHaveBeenCalledWith({
        where: { walletAddress: OWNER },
        select: { id: true },
      });
      expect(mockPrisma.route.count).toHaveBeenCalledWith({
        where: { providerId: { in: ['provider-1', 'provider-2'] } },
      });
      expect(stats.providers).toBe(2);
      expect(stats.routes).toBe(3);
      expect(stats.totalPayments).toBe(10);
      expect(stats.confirmedPayments).toBe(7);
      expect(stats.failedPayments).toBe(3);
    });
  });

  describe('expireStalePayments', () => {
    it('expires pending payments older than the quote window', async () => {
      (mockPrisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 5 });

      const count = await service.expireStalePayments(300);

      expect(count).toBe(5);
      const call = (mockPrisma.payment.updateMany as jest.Mock).mock.calls[0][0];
      expect(call.data).toEqual({ status: 'expired' });
      expect(call.where.status).toBe('pending');
      expect(call.where.createdAt.lt).toBeInstanceOf(Date);
    });
  });

  describe('writeAuditLog', () => {
    it('persists providerId on the audit entry', async () => {
      (mockPrisma.auditLog.create as jest.Mock).mockResolvedValue({ id: 'log-1' });

      await service.writeAuditLog({
        action: 'quote_generated',
        entity: 'quote',
        entityId: 'quote-1',
        providerId: 'provider-1',
        actor: 'system',
        details: { route: '/v1/chat/completions' },
      });

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: {
          action: 'quote_generated',
          entity: 'quote',
          entityId: 'quote-1',
          providerId: 'provider-1',
          actor: 'system',
          details: { route: '/v1/chat/completions' },
        },
      });
    });
  });

  describe('payouts', () => {
    const OWNER_PAYOUT = 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F';

    describe('getPendingPayoutAmount', () => {
      it('computes confirmed revenue minus executed payouts', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({ id: 'provider-1' });
        (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 10_000_000n },
        });
        (mockPrisma.payoutProposal.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 4_000_000n },
        });

        const pending = await service.getPendingPayoutAmount('provider-1', OWNER_PAYOUT);

        expect(pending).toBe(6_000_000n);
        expect(mockPrisma.payment.aggregate).toHaveBeenCalledWith({
          where: { providerId: 'provider-1', status: 'confirmed' },
          _sum: { amount: true },
        });
        expect(mockPrisma.payoutProposal.aggregate).toHaveBeenCalledWith({
          where: { providerId: 'provider-1', status: 'executed' },
          _sum: { amount: true },
        });
      });

      it('404s when the provider belongs to another wallet', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(
          service.getPendingPayoutAmount('provider-other', OWNER_PAYOUT),
        ).rejects.toThrow(NotFoundException);
        expect(mockPrisma.payment.aggregate).not.toHaveBeenCalled();
      });
    });

    describe('listPayouts', () => {
      it("scopes payout reads to the owner's providers", async () => {
        (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);
        (mockPrisma.payoutProposal.findMany as jest.Mock).mockResolvedValue([
          {
            id: 'payout-1',
            providerId: 'provider-1',
            proposalId: 3,
            destination: 'GB...',
            amount: 5_000_000n,
            asset: 'USDC',
            status: 'proposed',
            approvals: null,
            threshold: 1,
            txHash: null,
            error: null,
            executedAt: null,
            createdAt: new Date(),
          },
        ]);
        (mockPrisma.payoutProposal.count as jest.Mock).mockResolvedValue(1);

        const result = await service.listPayouts(OWNER_PAYOUT, { page: 1, limit: 20 });

        expect(mockPrisma.payoutProposal.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { providerId: { in: ['provider-1'] } },
            skip: 0,
            take: 20,
          }),
        );
        expect(result.data[0].amount).toBe('5000000'); // BigInt serialized to string
        expect(result.total).toBe(1);
      });

      it("404s for another wallet's provider filter", async () => {
        (mockPrisma.provider.findMany as jest.Mock).mockResolvedValue([{ id: 'provider-1' }]);

        await expect(
          service.listPayouts(OWNER_PAYOUT, { providerId: 'provider-other' }),
        ).rejects.toThrow(NotFoundException);
        expect(mockPrisma.payoutProposal.findMany).not.toHaveBeenCalled();
      });
    });

    describe('proposePayout', () => {
      it('proposes a payout for all pending revenue and auto-approves at threshold 1', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
          id: 'provider-1',
          walletAddress: OWNER_PAYOUT,
          payoutWalletAddress: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
        });
        (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 10_000_000n },
        });
        (mockPrisma.payoutProposal.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 0n },
        });
        (mockPrisma.payoutProposal.create as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          destination: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
          amount: 10_000_000n,
        });
        mockProposeMultisig.mockResolvedValue({ success: true, proposalId: 42 });
        (mockPrisma.payoutProposal.update as jest.Mock)
          .mockResolvedValueOnce({
            id: 'payout-1',
            providerId: 'provider-1',
            proposalId: 42,
            destination: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
            amount: 10_000_000n,
            status: 'proposed',
          })
          .mockResolvedValueOnce({
            id: 'payout-1',
            providerId: 'provider-1',
            proposalId: 42,
            destination: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
            amount: 10_000_000n,
            status: 'executed',
          });
        mockGetMultisigConfig.mockResolvedValue({
          signers: ['GSIGNER1'],
          threshold: 1,
          token: 'CTOKEN',
        });
        mockApproveMultisig.mockResolvedValue({ success: true, executed: true });
        // The internal auto-approve call re-fetches the proposal by id.
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          status: 'proposed',
          approvals: null,
          amount: 10_000_000n,
        });

        const result = await service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-1' });

        expect(mockProposeMultisig).toHaveBeenCalledWith(
          expect.objectContaining({
            destination: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
            amount: '10000000',
          }),
        );
        expect(result.autoApproved).toBe(true);
        expect(result.status).toBe('executed');
      });

      it('caps an explicit amount at the pending revenue', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
          id: 'provider-1',
          walletAddress: OWNER_PAYOUT,
          payoutWalletAddress: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
        });
        (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 5_000_000n },
        });
        (mockPrisma.payoutProposal.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 0n },
        });
        (mockPrisma.payoutProposal.create as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          amount: 5_000_000n,
        });
        mockProposeMultisig.mockResolvedValue({ success: true, proposalId: 1 });
        (mockPrisma.payoutProposal.update as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          proposalId: 1,
          amount: 5_000_000n,
          status: 'proposed',
        });
        mockGetMultisigConfig.mockResolvedValue({
          signers: ['GSIGNER1', 'GSIGNER2'],
          threshold: 2,
          token: 'CTOKEN',
        });

        const result = await service.proposePayout(OWNER_PAYOUT, {
          providerId: 'provider-1',
          amount: '999999999',
        });

        // Explicit amount is capped at pending revenue — never over-pay.
        expect(mockProposeMultisig).toHaveBeenCalledWith(
          expect.objectContaining({ amount: '5000000' }),
        );
        expect(result.autoApproved).toBe(false);
        expect(result.status).toBe('proposed');
      });

      it('fails cleanly when automation is disabled (no contract calls)', async () => {
        setConfig({
          ...baseConfig,
          payment: { ...baseConfig.payment, payoutAutomationEnabled: false },
        });

        await expect(
          service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-1' }),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(mockProposeMultisig).not.toHaveBeenCalled();
        expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
      });

      it('requires a payoutWalletAddress before proposing', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
          id: 'provider-1',
          walletAddress: OWNER_PAYOUT,
          payoutWalletAddress: null,
        });

        await expect(
          service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-1' }),
        ).rejects.toThrow(BadRequestException);
        expect(mockProposeMultisig).not.toHaveBeenCalled();
      });

      it('rejects a zero-amount payout when there is no pending revenue', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
          id: 'provider-1',
          walletAddress: OWNER_PAYOUT,
          payoutWalletAddress: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
        });
        (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 0n },
        });
        (mockPrisma.payoutProposal.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 0n },
        });

        await expect(
          service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-1' }),
        ).rejects.toThrow(BadRequestException);
        expect(mockPrisma.payoutProposal.create).not.toHaveBeenCalled();
      });

      it('marks the proposal failed when the on-chain propose fails', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue({
          id: 'provider-1',
          walletAddress: OWNER_PAYOUT,
          payoutWalletAddress: 'GBPROVIDERPAYOUT1234567890PAYOUT1234567890PAYOUT1',
        });
        (mockPrisma.payment.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 10_000_000n },
        });
        (mockPrisma.payoutProposal.aggregate as jest.Mock).mockResolvedValue({
          _sum: { amount: 0n },
        });
        (mockPrisma.payoutProposal.create as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          amount: 10_000_000n,
        });
        mockProposeMultisig.mockResolvedValue({ success: false, error: 'RPC down' });
        (mockPrisma.payoutProposal.update as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          status: 'failed',
        });

        await expect(
          service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-1' }),
        ).rejects.toThrow(ServiceUnavailableException);
        expect(mockPrisma.payoutProposal.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'failed', error: 'RPC down' }),
          }),
        );
      });

      it('404s when the provider is not owned by the caller', async () => {
        (mockPrisma.provider.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(
          service.proposePayout(OWNER_PAYOUT, { providerId: 'provider-other' }),
        ).rejects.toThrow(NotFoundException);
        expect(mockProposeMultisig).not.toHaveBeenCalled();
      });
    });

    describe('approvePayout', () => {
      it('approves a proposed payout and marks it executed when quorum is reached', async () => {
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          status: 'proposed',
          approvals: null,
          amount: 10_000_000n,
        });
        mockApproveMultisig.mockResolvedValue({ success: true, executed: true });
        (mockPrisma.payoutProposal.update as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          amount: 10_000_000n,
          status: 'executed',
        });

        const result = await service.approvePayout(OWNER_PAYOUT, 'payout-1');

        expect(mockApproveMultisig).toHaveBeenCalledWith(
          expect.objectContaining({ proposalId: 42 }),
        );
        expect(result.status).toBe('executed');
        expect(result.executed).toBe(true);
        expect(mockPrisma.payoutProposal.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'executed' }),
          }),
        );
      });

      it('marks approved (not executed) when quorum is not reached', async () => {
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          status: 'proposed',
          approvals: null,
          amount: 10_000_000n,
        });
        mockApproveMultisig.mockResolvedValue({ success: true, executed: false });
        (mockPrisma.payoutProposal.update as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          amount: 10_000_000n,
          status: 'approved',
        });

        const result = await service.approvePayout(OWNER_PAYOUT, 'payout-1');

        expect(result.status).toBe('approved');
        expect(result.executed).toBe(false);
      });

      it('rejects approval of an already-executed or failed proposal', async () => {
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          proposalId: 42,
          status: 'executed',
        });

        await expect(service.approvePayout(OWNER_PAYOUT, 'payout-1')).rejects.toThrow(
          BadRequestException,
        );
        expect(mockApproveMultisig).not.toHaveBeenCalled();
      });

      it('marks the proposal failed when the on-chain approval fails', async () => {
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          providerId: 'provider-1',
          proposalId: 42,
          status: 'proposed',
          approvals: null,
          amount: 10_000_000n,
        });
        mockApproveMultisig.mockResolvedValue({
          success: false,
          error: 'Not an authorized signer',
        });
        (mockPrisma.payoutProposal.update as jest.Mock).mockResolvedValue({
          id: 'payout-1',
          status: 'failed',
        });

        await expect(service.approvePayout(OWNER_PAYOUT, 'payout-1')).rejects.toThrow(
          ServiceUnavailableException,
        );
        expect(mockPrisma.payoutProposal.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'failed' }),
          }),
        );
      });

      it('404s when the proposal belongs to another wallet', async () => {
        (mockPrisma.payoutProposal.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(service.approvePayout(OWNER_PAYOUT, 'payout-other')).rejects.toThrow(
          NotFoundException,
        );
        expect(mockApproveMultisig).not.toHaveBeenCalled();
      });
    });
  });
});
