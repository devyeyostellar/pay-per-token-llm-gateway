/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  proposeMultisig,
  approveMultisig,
  getMultisigConfig,
  getMultisigProposal,
} from './multisig-client';

// ── Mocks ────────────────────────────────────

const mockKeypairFromSecret = jest.fn();
const mockSign = jest.fn();
const mockSend = jest.fn();
const mockSignAuthEntries = jest.fn();
const mockClientFrom = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
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

const mockGetConfig = jest.fn();
const mockGetProposal = jest.fn();
const mockPropose = jest.fn();
const mockApprove = jest.fn();

// Real Keypair from the un-mocked SDK — generates addresses with valid
// checksums so Address.fromString (used by soroban-utils) parses them.
const RealSdk = jest.requireActual('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
const adminKp = RealSdk.Keypair.random();
const signer1Kp = RealSdk.Keypair.random();
const signer2Kp = RealSdk.Keypair.random();
const destKp = RealSdk.Keypair.random();

const ADMIN = adminKp.publicKey();
const SIGNER1 = signer1Kp.publicKey();
const SIGNER2 = signer2Kp.publicKey();
const DESTINATION = destKp.publicKey();
const CONTRACT_ID = 'CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA';
const TOKEN_ID = 'CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP';

beforeEach(() => {
  jest.clearAllMocks();
  mockKeypairFromSecret.mockReturnValue({
    sign: mockSign,
    signAuthEntries: mockSignAuthEntries,
    publicKey: () => ADMIN,
  });
  mockClientFrom.mockResolvedValue({
    get_config: mockGetConfig,
    get_proposal: mockGetProposal,
    propose: mockPropose,
    approve: mockApprove,
  });
});

const BASE = {
  contractId: CONTRACT_ID,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

function makeTx(executed = false) {
  return {
    sign: mockSign,
    signAuthEntries: mockSignAuthEntries,
    send: mockSend,
    result: executed,
  };
}

describe('multisig-client', () => {
  describe('proposeMultisig', () => {
    it('proposes on-chain and returns the proposal id', async () => {
      mockPropose.mockResolvedValue(makeTx(false));
      mockSend.mockResolvedValue(undefined);

      const result = await proposeMultisig({
        ...BASE,
        adminSecret: adminKp.secret(),
        destination: DESTINATION,
        amount: '1000000',
      });

      expect(result.success).toBe(true);
      expect(result.proposalId).toBe(0);
      expect(mockPropose).toHaveBeenCalledTimes(1);
      expect(mockSign).toHaveBeenCalled();
      expect(mockSend).toHaveBeenCalled();
    });

    it('returns an error result when the contract call fails', async () => {
      mockPropose.mockRejectedValue(new Error('RPC unavailable'));

      const result = await proposeMultisig({
        ...BASE,
        adminSecret: adminKp.secret(),
        destination: DESTINATION,
        amount: '1000000',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('RPC unavailable');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns an error when the admin secret is invalid', async () => {
      mockKeypairFromSecret.mockImplementation(() => {
        throw new Error('Invalid secret');
      });

      const result = await proposeMultisig({
        ...BASE,
        adminSecret: 'not-a-secret',
        destination: DESTINATION,
        amount: '1000000',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid secret');
    });
  });

  describe('approveMultisig', () => {
    it('approves on-chain and reports execution when quorum is reached', async () => {
      mockApprove.mockResolvedValue(makeTx(true));
      mockSend.mockResolvedValue(undefined);

      const result = await approveMultisig({
        ...BASE,
        signerSecret: signer1Kp.secret(),
        signer: SIGNER1,
        proposalId: 7,
      });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(true);
      expect(mockApprove).toHaveBeenCalledTimes(1);
      expect(mockSignAuthEntries).toHaveBeenCalled();
    });

    it('reports not-executed when the approval does not reach quorum', async () => {
      mockApprove.mockResolvedValue(makeTx(false));
      mockSend.mockResolvedValue(undefined);

      const result = await approveMultisig({
        ...BASE,
        signerSecret: signer1Kp.secret(),
        signer: SIGNER1,
        proposalId: 7,
      });

      expect(result.success).toBe(true);
      expect(result.executed).toBe(false);
    });

    it('returns an error when the signer is not authorized (on-chain panic)', async () => {
      mockApprove.mockRejectedValue(new Error('Not an authorized signer'));

      const result = await approveMultisig({
        ...BASE,
        signerSecret: signer2Kp.secret(),
        signer: SIGNER2,
        proposalId: 7,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not an authorized signer');
    });
  });

  describe('getMultisigConfig', () => {
    it('parses the config from the contract read', async () => {
      mockGetConfig.mockResolvedValue({
        result: {
          signers: [SIGNER1, SIGNER2],
          threshold: 2,
          token: TOKEN_ID,
        },
      });

      const config = await getMultisigConfig(BASE.contractId, BASE.rpcUrl, BASE.networkPassphrase);

      expect(config).not.toBeNull();
      expect(config!.signers).toHaveLength(2);
      expect(config!.threshold).toBe(2);
      expect(config!.token).toBe(TOKEN_ID);
    });

    it('returns null when the read fails', async () => {
      mockGetConfig.mockRejectedValue(new Error('Contract not found'));

      const config = await getMultisigConfig(BASE.contractId, BASE.rpcUrl, BASE.networkPassphrase);

      expect(config).toBeNull();
    });
  });

  describe('getMultisigProposal', () => {
    it('parses a proposal from the contract read', async () => {
      mockGetProposal.mockResolvedValue({
        result: {
          id: 3,
          destination: DESTINATION,
          amount: 5000000,
          executed: false,
          approvals: [SIGNER1],
          createdAt: 1750000000,
        },
      });

      const proposal = await getMultisigProposal(
        BASE.contractId,
        BASE.rpcUrl,
        BASE.networkPassphrase,
        3,
      );

      expect(proposal).not.toBeNull();
      expect(proposal!.id).toBe(3);
      expect(proposal!.amount).toBe('5000000');
      expect(proposal!.executed).toBe(false);
      expect(proposal!.approvals).toHaveLength(1);
    });

    it('returns null when the read fails', async () => {
      mockGetProposal.mockRejectedValue(new Error('boom'));

      const proposal = await getMultisigProposal(
        BASE.contractId,
        BASE.rpcUrl,
        BASE.networkPassphrase,
        99,
      );

      expect(proposal).toBeNull();
    });
  });
});
