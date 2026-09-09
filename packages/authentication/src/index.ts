// ──────────────────────────────────────────────
// @x402/authentication — Wallet-based auth
// ──────────────────────────────────────────────
//
// AuthStore provides Redis-backed challenge and session storage with
// an automatic in-memory fallback when Redis is unavailable.
//
// This follows the same Redis + fallback pattern as ReplayProtection
// in @x402/x402-core.

import { generateId, type RedisLike } from '@x402/shared';
import { verifyChallenge } from '@x402/wallet';
import { logger } from '@x402/logger';
import type { StellarAddress } from '@x402/types';

// Re-export the shared RedisLike as AuthRedisLike for backward compatibility.
export type { RedisLike as AuthRedisLike } from '@x402/shared';

// ── Session Type ─────────────────────────────

export interface Session {
  sessionId: string;
  address: StellarAddress;
  createdAt: number;
  expiresAt: number;
}

// ── Internal Types ───────────────────────────

interface ChallengeRecord {
  challenge: string;
  expiresAt: number;
  used: boolean;
}

// ── AuthStore ────────────────────────────────

/**
 * Redis-backed authentication store with in-memory fallback.
 *
 * When a Redis client is provided via constructor, all challenges and
 * sessions are persisted to Redis with proper TTLs. This survives
 * server restarts and works correctly in multi-instance deployments.
 *
 * When no Redis client is provided, falls back to in-memory Maps
 * (useful for development and testing).
 */
export class AuthStore {
  private readonly redis: RedisLike | null;

  // In-memory fallback stores
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly sessions = new Map<string, Session>();

  private static readonly CHALLENGE_PREFIX = 'x402:auth:challenge:';
  private static readonly SESSION_PREFIX = 'x402:auth:session:';
  private static readonly CHALLENGE_TTL = 300; // 5 minutes

  constructor(redis?: RedisLike) {
    this.redis = redis ?? null;
  }

  // ── Challenge Management ────────────────────

  /**
   * Create a new authentication challenge for a wallet address.
   * The client signs this challenge to prove wallet ownership.
   */
  async createChallenge(address: StellarAddress): Promise<{
    challengeId: string;
    challenge: string;
  }> {
    const challengeId = generateId();
    const challenge = `x402-gateway-auth-${generateId()}-${Date.now()}`;
    const ttl = AuthStore.CHALLENGE_TTL;

    const record: ChallengeRecord = {
      challenge,
      expiresAt: Date.now() + ttl * 1000,
      used: false,
    };

    if (this.redis) {
      await this.redis.set(
        AuthStore.CHALLENGE_PREFIX + challengeId,
        JSON.stringify(record),
        'EX',
        String(ttl),
      );
    } else {
      this.challenges.set(challengeId, record);
    }

    logger.debug('Created auth challenge', { challengeId, address });

    return { challengeId, challenge };
  }

  /**
   * Verify a signed challenge response.
   *
   * On success the challenge is marked as used and deleted to prevent replay.
   */
  async verifyChallenge(
    challengeId: string,
    address: StellarAddress,
    signature: string,
  ): Promise<{ verified: boolean; error?: string }> {
    let record: ChallengeRecord | undefined;

    if (this.redis) {
      const raw = await this.redis.get(AuthStore.CHALLENGE_PREFIX + challengeId);
      if (raw) {
        try {
          record = JSON.parse(raw) as ChallengeRecord;
        } catch {
          record = undefined;
        }
      }
    } else {
      record = this.challenges.get(challengeId);
    }

    if (!record) {
      return { verified: false, error: 'Challenge not found' };
    }

    if (record.used) {
      // Clean up used challenge from Redis on re-attempt
      if (this.redis) {
        await this.redis.del(AuthStore.CHALLENGE_PREFIX + challengeId);
      }
      return { verified: false, error: 'Challenge already used (replay protection)' };
    }

    if (Date.now() > record.expiresAt) {
      // Clean up expired challenge
      if (this.redis) {
        await this.redis.del(AuthStore.CHALLENGE_PREFIX + challengeId);
      } else {
        this.challenges.delete(challengeId);
      }
      return { verified: false, error: 'Challenge expired' };
    }

    const isValid = verifyChallenge(address, record.challenge, signature);

    if (isValid) {
      // Mark as used and delete to prevent replay
      if (this.redis) {
        await this.redis.del(AuthStore.CHALLENGE_PREFIX + challengeId);
      } else {
        this.challenges.delete(challengeId);
      }
    }

    return { verified: isValid, error: isValid ? undefined : 'Invalid signature' };
  }

  // ── Session Management ──────────────────────

  /**
   * Create a new session after successful authentication.
   * Sessions are stored in Redis with TTL matching their duration.
   */
  async createSession(address: StellarAddress, sessionDurationSeconds = 86400): Promise<Session> {
    const session: Session = {
      sessionId: generateId(),
      address,
      createdAt: Date.now(),
      expiresAt: Date.now() + sessionDurationSeconds * 1000,
    };

    if (this.redis) {
      await this.redis.set(
        AuthStore.SESSION_PREFIX + session.sessionId,
        JSON.stringify(session),
        'EX',
        String(sessionDurationSeconds),
      );
    } else {
      this.sessions.set(session.sessionId, session);
    }

    return session;
  }

  /**
   * Validate a session by ID.
   * Returns the session if valid, or null if expired/not found.
   */
  async validateSession(sessionId: string): Promise<Session | null> {
    let session: Session | undefined;

    if (this.redis) {
      const raw = await this.redis.get(AuthStore.SESSION_PREFIX + sessionId);
      if (raw) {
        try {
          session = JSON.parse(raw) as Session;
        } catch {
          session = undefined;
        }
      }
    } else {
      session = this.sessions.get(sessionId);
    }

    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      // Clean up expired session
      if (this.redis) {
        await this.redis.del(AuthStore.SESSION_PREFIX + sessionId);
      } else {
        this.sessions.delete(sessionId);
      }
      return null;
    }

    return session;
  }

  /**
   * Destroy a session (logout).
   */
  async destroySession(sessionId: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(AuthStore.SESSION_PREFIX + sessionId);
    } else {
      this.sessions.delete(sessionId);
    }
  }
}

// ── Global Singleton ──────────────────────────

/**
 * Global AuthStore singleton.
 *
 * By default uses in-memory storage. In production, call `setAuthStore()`
 * with a Redis-backed AuthStore during application bootstrap.
 */
let _defaultStore: AuthStore = new AuthStore();

/**
 * Replace the global AuthStore instance.
 * Called at gateway startup with a Redis-backed store.
 */
export function setAuthStore(store: AuthStore): void {
  _defaultStore = store;
  logger.info('AuthStore replaced with custom instance');
}

/**
 * Get the current AuthStore (for testing).
 */
export function getAuthStore(): AuthStore {
  return _defaultStore;
}

// ── Standalone Wrappers (backward-compatible) ──

/**
 * @deprecated Use `authStore.createChallenge(address)` directly.
 * Delegates to the global AuthStore singleton.
 */
export async function createAuthChallenge(address: StellarAddress) {
  return _defaultStore.createChallenge(address);
}

/**
 * @deprecated Use `authStore.verifyChallenge(challengeId, address, signature)` directly.
 * Delegates to the global AuthStore singleton.
 */
export async function verifyAuthChallenge(
  challengeId: string,
  address: StellarAddress,
  signature: string,
) {
  return _defaultStore.verifyChallenge(challengeId, address, signature);
}

/**
 * @deprecated Use `authStore.createSession(address, duration)` directly.
 * Delegates to the global AuthStore singleton.
 */
export async function createSession(address: StellarAddress, sessionDurationSeconds?: number) {
  return _defaultStore.createSession(address, sessionDurationSeconds);
}

/**
 * @deprecated Use `authStore.validateSession(sessionId)` directly.
 * Delegates to the global AuthStore singleton.
 */
export async function validateSession(sessionId: string) {
  return _defaultStore.validateSession(sessionId);
}

/**
 * @deprecated Use `authStore.destroySession(sessionId)` directly.
 * Delegates to the global AuthStore singleton.
 */
export async function destroySession(sessionId: string) {
  return _defaultStore.destroySession(sessionId);
}

/**
 * Clean up expired sessions from the in-memory fallback store.
 * No-op when Redis is in use (Redis handles expiry via TTL).
 */
export function cleanupSessions(): number {
  const store = _defaultStore;
  if ((store as unknown as { redis?: unknown }).redis) return 0;

  // Access private field for cleanup — only works with in-memory fallback
  const sessionsMap = (store as unknown as { sessions?: Map<string, Session> }).sessions;
  if (!sessionsMap) return 0;

  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessionsMap) {
    if (now > session.expiresAt) {
      sessionsMap.delete(id);
      cleaned++;
    }
  }

  return cleaned;
}
