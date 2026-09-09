/* eslint-disable @typescript-eslint/no-explicit-any */
import { chargeEscrow, refundEscrow, settleEscrow } from './escrow-client';

// The escrow client dynamically imports `@stellar/stellar-sdk` (the `contract`
// namespace for the spec client) and uses `Keypair.fromSecret` statically.
// Mock the module so contract calls never touch a network.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as any;
  return {
    ...actual,
    Keypair: {
      ...actual.Keypair,
      fromSecret: (...args: unknown[]) => mockKeypairFromSecret(...args),
    },
    contract: {
      Client: {
        from: (...args: unknown[]) => mockClientFrom(...args),
      },
    },
  };
});

const mockKeypairFromSecret = jest.fn();
const mockClientFrom = jest.fn();
const mockSign = jest.fn();
const mockSend = jest.fn();
const mockSignAuthEntries = jest.fn();

const RealSdk = jest.requireActual('@stellar/stellar-sdk') as any;
const adminKp = RealSdk.Keypair.random();
const userKp = RealSdk.Keypair.random();
const USER = userKp.publicKey();

const BASE = {
  contractId: 'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  adminSecret: adminKp.secret(),
  user: USER,
  amount: '100000',
  quoteId: 'quote-abc',
};

function makeTx() {
  return {
    sign: mockSign,
    signAuthEntries: mockSignAuthEntries,
    send: mockSend,
  };
}

beforeEach(() => {
  // resetAllMocks (not just clear) so mockResolvedValueOnce queues from one
  // test never leak into the next.
  jest.resetAllMocks();
  mockKeypairFromSecret.mockReturnValue({
    sign: mockSign,
    signAuthEntries: mockSignAuthEntries,
    publicKey: () => adminKp.publicKey(),
  });
  mockClientFrom.mockResolvedValue({
    charge: jest.fn().mockResolvedValue(makeTx()),
    refund: jest.fn().mockResolvedValue(makeTx()),
  });
  mockSend.mockResolvedValue(undefined);
});

describe('escrow-client', () => {
  describe('chargeEscrow', () => {
    it('charges on-chain and returns success', async () => {
      const result = await chargeEscrow(BASE);

      expect(result.success).toBe(true);
      expect(mockSign).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    it('returns an error result (never throws) when the contract call fails', async () => {
      mockClientFrom.mockResolvedValue({
        charge: jest.fn().mockRejectedValue(new Error('Quote already charged')),
      });

      const result = await chargeEscrow(BASE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Quote already charged');
    });

    it('returns an error when the admin secret is invalid', async () => {
      mockKeypairFromSecret.mockImplementation(() => {
        throw new Error('Invalid secret');
      });

      const result = await chargeEscrow({ ...BASE, adminSecret: 'bad' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid secret');
    });
  });

  describe('refundEscrow', () => {
    it('refunds on-chain and returns success', async () => {
      const result = await refundEscrow(BASE);

      expect(result.success).toBe(true);
      expect(mockSend).toHaveBeenCalled();
    });

    it('returns an error result (never throws) when the contract call fails', async () => {
      mockClientFrom.mockResolvedValue({
        refund: jest.fn().mockRejectedValue(new Error('Insufficient prepaid balance')),
      });

      const result = await refundEscrow(BASE);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient prepaid balance');
    });
  });

  describe('settleEscrow', () => {
    it('is a silent no-op when disabled (no contract calls)', async () => {
      await settleEscrow({
        ...BASE,
        enabled: false,
        adminSecret: undefined,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('is a silent no-op when adminSecret is missing even if enabled', async () => {
      await settleEscrow({
        ...BASE,
        enabled: true,
        adminSecret: undefined,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).not.toHaveBeenCalled();
    });

    it('charges the actual cost when enabled', async () => {
      mockClientFrom
        .mockResolvedValueOnce({
          charge: jest.fn().mockResolvedValue(makeTx()),
        })
        .mockResolvedValueOnce({
          refund: jest.fn().mockResolvedValue(makeTx()),
        });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '5000',
        isOverpaid: true,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('charges only (no refund) when not overpaid', async () => {
      mockClientFrom.mockResolvedValueOnce({
        charge: jest.fn().mockResolvedValue(makeTx()),
      });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '0',
        isOverpaid: false,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('skips the refund when the charge fails (never refund on a failed charge)', async () => {
      mockClientFrom.mockResolvedValueOnce({
        charge: jest.fn().mockRejectedValue(new Error('RPC down')),
      });

      await settleEscrow({
        ...BASE,
        enabled: true,
        actualCost: '100000',
        surplus: '5000',
        isOverpaid: true,
      });

      expect(mockClientFrom).toHaveBeenCalledTimes(1);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
