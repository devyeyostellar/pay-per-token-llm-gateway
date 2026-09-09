/** @jest-environment jsdom */

import { setSessionToken, setWalletAddress, getWalletAddress } from './api';

describe('in-memory session token', () => {
  it('stores a token without touching localStorage', () => {
    setSessionToken('test-token-123');
    expect(localStorage.getItem('x402-session-token')).toBeNull();
  });
});

describe('wallet address management', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores and retrieves the wallet address', () => {
    setWalletAddress('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
    expect(getWalletAddress()).toBe('GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F');
  });

  it('returns null when no wallet address is stored', () => {
    expect(getWalletAddress()).toBeNull();
  });
});
