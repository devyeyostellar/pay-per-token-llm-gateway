/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Property-based tests (deterministic, seeded — no external fuzz runner).
 *
 * These assert algebraic invariants over randomized inputs:
 *   - stroop ⇄ unit conversion round-trips without loss
 *   - unitsToStroops never overflows / never emits non-digits
 *   - generated quotes always respect minPaymentAmount and positive prices
 *   - comparePayment satisfies  paid == cost + surplus
 *   - calculatePrice satisfies  amount == perTokenPrice × tokenCount
 *
 * A seeded PRNG keeps failures reproducible: the seed is fixed, so any
 * failing property can be re-run with the same inputs.
 */

import { generateQuote, calculatePrice, comparePayment } from './index';
import { unitsToStroops, stroopsToUnits } from '@x402/shared';
import type { RouteConfig } from '@x402/types';

// ── Seeded PRNG (mulberry32) ─────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x402402;
const ITERATIONS = 500;

function randomStroops(rand: () => number): string {
  // Values from 0 to 10^18 (well above any realistic USDC balance).
  const magnitude = Math.floor(rand() * 19); // 0..18
  const value = BigInt(Math.floor(rand() * 1_000_000_000));
  return (value * 10n ** BigInt(magnitude)).toString();
}

function randomAmountWithDecimals(rand: () => number): string {
  const whole = Math.floor(rand() * 1_000_000_000);
  const fractionDigits = Math.floor(rand() * 8); // 0..7
  let fraction = '';
  for (let i = 0; i < 7; i++) {
    fraction += i < fractionDigits ? String(Math.floor(rand() * 10)) : '0';
  }
  // Trim trailing zeros the way Horizon does (optional), keep at least one char
  return fraction.replace(/0+$/, '') ? `${whole}.${fraction.replace(/0+$/, '')}` : `${whole}`;
}

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    id: 'route-1',
    providerId: 'provider-1',
    path: '/v1/chat/completions',
    upstreamUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4',
    pricingModel: 'flat',
    flatPrice: '1000000',
    perTokenPrice: undefined,
    acceptedAssets: ['USDC'],
    rateLimit: 10,
    active: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Properties ────────────────────────────────

describe('property: amount conversions round-trip without loss', () => {
  const rand = mulberry32(SEED);

  it('unitsToStroops(stroopsToUnits(x)) === x for random stroop amounts', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const stroops = randomStroops(rand);
      expect(unitsToStroops(stroopsToUnits(stroops))).toBe(stroops);
    }
  });

  it('unitsToStroops parses any ≤7-decimal amount to its exact stroop value', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const decimal = randomAmountWithDecimals(rand);
      const [whole, fraction = ''] = decimal.split('.');
      const padded = fraction.padEnd(7, '0');
      const expected = (BigInt(whole) * 10_000_000n + BigInt(padded || '0')).toString();
      expect(unitsToStroops(decimal)).toBe(expected);
    }
  });

  it('stroopsToUnits only ever emits digits and a single decimal point', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const units = stroopsToUnits(randomStroops(rand));
      expect(units).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it('handles the extreme values without precision loss', () => {
    expect(unitsToStroops(stroopsToUnits('0'))).toBe('0');
    expect(unitsToStroops(stroopsToUnits('1'))).toBe('1');
    const max = '9999999999999999999999999999';
    expect(unitsToStroops(stroopsToUnits(max))).toBe(max);
  });
});

describe('property: quote generation invariants', () => {
  it('never quotes below minPaymentAmount for random per-token configs', () => {
    const rand = mulberry32(SEED + 1);
    for (let i = 0; i < ITERATIONS; i++) {
      const price = (BigInt(Math.floor(rand() * 100_000)) + 1n).toString();
      const estimate = Math.floor(rand() * 4096) + 1;
      const route = makeRoute({
        pricingModel: 'per_token',
        perTokenPrice: price,
        flatPrice: undefined,
      });
      const quote = generateQuote({
        route,
        providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
        gatewayBaseUrl: 'http://localhost:3000',
        network: 'testnet',
        quoteExpirySeconds: 300,
        usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        minPaymentAmount: '10000',
        estimatedTokens: estimate,
      });

      // deposit == price × estimate, clamped up to the minimum
      const raw = BigInt(price) * BigInt(estimate);
      expect(BigInt(quote.amount)).toBe(raw < 10_000n ? 10_000n : raw);
      expect(BigInt(quote.amount)).toBeGreaterThan(0n);
    }
  });

  it('flat quotes are clamped to minPaymentAmount but never below zero', () => {
    const rand = mulberry32(SEED + 2);
    for (let i = 0; i < ITERATIONS; i++) {
      const flat = BigInt(Math.floor(rand() * 100_000)).toString();
      const route = makeRoute({ pricingModel: 'flat', flatPrice: flat, perTokenPrice: undefined });
      const quote = generateQuote({
        route,
        providerAddress: 'GA5ZSE6VKPVFLEXMWJQBGHE4FJHKQIFSJMLQ7H4VFQB4UHLEH5IOVK3F',
        gatewayBaseUrl: 'http://localhost:3000',
        network: 'testnet',
        quoteExpirySeconds: 300,
        usdcIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        minPaymentAmount: '10000',
      });

      const expected = BigInt(flat) < 10_000n ? 10_000n : BigInt(flat);
      expect(BigInt(quote.amount)).toBe(expected);
      expect(BigInt(quote.amount)).toBeGreaterThan(0n);
    }
  });
});

describe('property: price arithmetic identities', () => {
  it('calculatePrice satisfies amount == perTokenPrice × tokenCount', () => {
    const rand = mulberry32(SEED + 3);
    for (let i = 0; i < ITERATIONS; i++) {
      const price = (BigInt(Math.floor(rand() * 100_000)) + 1n).toString();
      const tokens = Math.floor(rand() * 100_000) + 1;
      const route = makeRoute({
        pricingModel: 'per_token',
        perTokenPrice: price,
        flatPrice: undefined,
      });
      expect(calculatePrice({ route, tokenCount: tokens }).amount).toBe(
        (BigInt(price) * BigInt(tokens)).toString(),
      );
    }
  });

  it('comparePayment satisfies paid == cost + surplus', () => {
    const rand = mulberry32(SEED + 4);
    for (let i = 0; i < ITERATIONS; i++) {
      const paid = randomStroops(rand);
      const cost = randomStroops(rand);
      const { surplus, isOverpaid, isUnderpaid } = comparePayment(paid, cost);
      expect(BigInt(paid) - BigInt(cost)).toBe(BigInt(surplus));
      expect(isOverpaid).toBe(BigInt(surplus) > 0n);
      expect(isUnderpaid).toBe(BigInt(surplus) < 0n);
      expect(isOverpaid && isUnderpaid).toBe(false);
    }
  });
});
