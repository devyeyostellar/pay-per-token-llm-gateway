'use client';

import { useState, useEffect, useCallback } from 'react';
import { validateSession, endSession, getWalletAddress } from './api';

/**
 * Shared module-level auth state so data-fetching hooks can check
 * authentication status without being inside a React tree. Updated by
 * useAuth() on every mount.
 */
let globalIsConnected = false;
export function isAuthenticated(): boolean {
  return globalIsConnected;
}

export function useAuth() {
  const [address, setAddress] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const checkSession = useCallback(async () => {
    try {
      const result = await validateSession();
      setAddress(result.address);
      globalIsConnected = true;
    } catch {
      setAddress(null);
      globalIsConnected = false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Quick check from localStorage first for instant UI
    const stored = getWalletAddress();
    if (stored) setAddress(stored);

    // Then validate with the gateway (this also triggers the legacy
    // localStorage token migration if one exists).
    checkSession();
  }, [checkSession]);

  const disconnect = useCallback(async () => {
    try {
      // The gateway clears the httpOnly session cookie on this call.
      await endSession();
    } catch {
      // Even if the API call fails, clear local state
    }
    setAddress(null);
    globalIsConnected = false;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('x402-wallet-address');
    }
  }, []);

  return { address, loading, isConnected: !!address, disconnect, refresh: checkSession };
}
