// ──────────────────────────────────────────────
// @x402/shared — Shared utilities and helpers
// ──────────────────────────────────────────────

import { randomUUID } from 'crypto';

/** Generate a UUID v4 */
export function generateId(): string {
  return randomUUID();
}

/** Convert a Unix timestamp (seconds) to ISO string */
export function unixToISO(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

/** Get current Unix timestamp in seconds */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** Sleep for a given number of milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error that must never be retried (e.g. upstream 4xx client errors).
 * Throwing this inside a `retry` callback aborts the retry loop immediately.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Retry a function with exponential backoff */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {},
): Promise<T> {
  const { maxAttempts = 5, baseDelayMs = 500, maxDelayMs = 10000, onRetry } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Client/configuration errors will never succeed on retry — abort immediately.
      if (error instanceof NonRetryableError) throw error;
      if (attempt === maxAttempts) throw error;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      onRetry?.(attempt, error as Error);
      await sleep(jitter);
    }
  }
  throw new Error('Retry failed');
}

/** Truncate a string with ellipsis */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

/** Mask a sensitive string (e.g., API key) showing only last 4 chars */
export function maskSensitive(value: string, showChars = 4): string {
  if (value.length <= showChars) return '*'.repeat(value.length);
  return '*'.repeat(value.length - showChars) + value.slice(-showChars);
}

/** Format an amount in smallest unit to a human-readable string */
export function formatAmount(amount: string, decimals: number): string {
  const num = BigInt(amount);
  const divisor = BigInt(10 ** decimals);
  const whole = num / divisor;
  const fraction = num % divisor;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractionStr ? `${whole}.${fractionStr}` : whole.toString();
}

/**
 * Parse a human-readable amount to smallest unit string.
 *
 * NOTE: inputs with more than `decimals` fractional digits are interpreted
 * as-is rather than truncated/rounded (Horizon never returns more than 7
 * decimals for Stellar assets, so this only matters for misuse).
 */
export function parseAmount(amount: string, decimals: number): string {
  const [whole, fraction = ''] = amount.split('.');
  const padded = fraction.padEnd(decimals, '0');
  return (BigInt(whole) * BigInt(10 ** decimals) + BigInt(padded)).toString();
}

/**
 * All Stellar assets use 7-decimal precision: 1 stroop = 1e-7 asset units.
 * Horizon reports payment amounts as decimal strings in asset units
 * (e.g. "0.1000000"), while x402 quotes use stroops (e.g. "1000000").
 */
export const STELLAR_DECIMALS = 7;

/**
 * Convert a Horizon decimal amount in asset units (e.g. "0.1000000")
 * to stroops (e.g. "1000000"). Used when verifying on-chain payments
 * against x402 quote amounts.
 */
export function unitsToStroops(amount: string, decimals: number = STELLAR_DECIMALS): string {
  return parseAmount(amount, decimals);
}

/**
 * Convert an amount in stroops (e.g. "1000000") to decimal asset units
 * (e.g. "0.1") as expected by the stellar-sdk `Operation.payment`.
 */
export function stroopsToUnits(amount: string, decimals: number = STELLAR_DECIMALS): string {
  return formatAmount(amount, decimals);
}

/** Safe JSON parse with default value */
export function safeJsonParse<T>(str: string, defaultValue: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return defaultValue;
  }
}

/** Check if a value is a valid Stellar address */
export function isValidStellarAddress(address: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(address);
}

/** Check if a value is a valid transaction hash */
export function isValidTxHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/i.test(hash);
}

// ── Redis Interface ──────────────────────────

/**
 * Minimal interface for Redis operations used across the gateway.
 * ioredis satisfies this interface natively.
 *
 * Shared by {@link ReplayProtection} (x402-core) and {@link AuthStore}
 * (authentication) so the Redis + in-memory fallback pattern is
 * defined once.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: string[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
}
