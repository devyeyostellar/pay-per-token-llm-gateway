#!/usr/bin/env bash
set -euo pipefail

# ── Issue 1: Wire Credit Escrow Settlement ──────────────────────────
cat > /tmp/issue1.md << 'ISSUEBODY'
## Problem

Per-token pricing detects underpayment (`applyMeteredPricing` logs `isUnderpaid`) but **never settles** via the on-chain credit-escrow contract. The `ESCROW_SETTLEMENT_ENABLED` config flag exists in `.env.example` and `@x402/config` but no gateway code calls `charge()` / `refund()`. The README claims "gateway charges actual cost from the caller's escrow balance and auto-refunds surplus" — this doesn't work.

## Scope

- Gate the settlement path behind `escrowSettlementEnabled` config (default `false`)
- After a metered LLM response completes, call `credit-escrow.charge(user, quoteId, actualCost)` to deduct actual usage
- Call `credit-escrow.refund(user, quoteId, surplus)` for any unused deposit
- Add a `contract-client.ts` counterpart for the credit-escrow contract (or extend the existing `contract-client.ts`)
- Log a warning (not error) when `escrowSettlementEnabled=false` and a per-token route is used

## Files to Modify

| File | What |
|---|---|
| `apps/gateway/src/modules/x402/contract-client.ts` | Add `chargeEscrow()`, `refundEscrow()` helpers |
| `apps/gateway/src/modules/x402/x402.service.ts` | Call settlement after metered pricing calc |
| `apps/gateway/src/modules/proxy/proxy.service.ts` | Wire settlement into the response path |
| `contracts/credit-escrow/src/lib.rs` | Reference only — existing `charge`/`refund`/`get_usage` are already implemented |

## Acceptance Criteria

- [ ] When `ESCROW_SETTLEMENT_ENABLED=true`, a per-token request that completes successfully calls `charge(user, quoteId, actualCost)` on-chain
- [ ] Surplus deposits trigger `refund(user, quoteId, surplus)` on-chain
- [ ] When `ESCROW_SETTLEMENT_ENABLED=false`, the gateway logs a warning and skips settlement (no crash)
- [ ] Settlement calls are idempotent (contract already supports this — verify no double-charge)
- [ ] Unit tests cover both enabled/disabled paths (`x402.service.spec.ts`)
- [ ] E2E test covers the settlement flow (mock the contract client)
- [ ] `pnpm exec nx test gateway` passes with 100% of new code covered
ISSUEBODY

gh issue create \
  --title "feat: wire credit-escrow settlement for metered per-token pricing" \
  --label "enhancement,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:gateway,area:contracts,high,bounty" \
  --body-file /tmp/issue1.md
echo "✓ Issue 1 created"

# ── Issue 2: SDK External Signer ────────────────────────────────────
cat > /tmp/issue2.md << 'ISSUEBODY'
## Problem

`X402Client.executePayment()` contains a stub that always returns an error when an external `signTransaction` callback is provided:

```ts
if (this.config.signTransaction) {
  return { success: false, error: 'External wallet signing not yet implemented — provide a secretKey' };
}
```

The README and `@x402/types` advertise "Stellar wallet integration (secret key or external signer)", but external signers (Freighter, xBull, Albedo — the primary integration path for browser/agent apps) are **broken by design**.

## Scope

- Build the transaction via the existing `buildPaymentTransaction` helper
- When `signTransaction` is provided, call it with the `txXdr` (base64-encoded transaction envelope)
- Submit the signed XDR to Horizon
- Poll for confirmation (reuse existing polling logic)
- Return the confirmed transaction hash

## Files to Modify

| File | What |
|---|---|
| `packages/sdk/src/index.ts` | Replace the stub in `executePayment()` with real implementation |
| `packages/types/src/index.ts` | Verify `signTransaction` callback signature is correct |

## Acceptance Criteria

- [ ] `X402Client` with `signTransaction` callback (no `secretKey`) calls the callback with a valid `txXdr`
- [ ] The signed XDR is submitted to Horizon and confirmed
- [ ] The returned `PaymentResult` matches the same shape as the `secretKey` path
- [ ] Error handling: invalid XDR, rejected signing, failed submission all return `{ success: false, error: string }`
- [ ] Existing `secretKey` path continues to work unchanged
- [ ] Unit tests for both `secretKey` and `signTransaction` paths
- [ ] `pnpm exec nx test sdk` passes (add Jest config if missing)
ISSUEBODY

gh issue create \
  --title "fix: implement external signer path in SDK executePayment" \
  --label "bug,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:sdk,high,bounty" \
  --body-file /tmp/issue2.md
echo "✓ Issue 2 created"

# ── Issue 3: Clamp Unbounded Pagination ─────────────────────────────
cat > /tmp/issue3.md << 'ISSUEBODY'
## Problem

All three contracts (`payment-verifier`, `credit-escrow`, `multisig`) paginate with:

```rust
let end = (offset + limit).min(count);
for i in offset..end { ... }
```

A caller can pass `limit = u32::MAX` and `offset = 0` — the loop iterates up to `count` entries, which is a predictable gas-exhaustion / archive-read DoS vector. Additionally, `offset + limit` can overflow `u32` (panics in debug, wraps in release).

## Scope

- Add `.min(100)` clamp on `limit` in each paginated function
- Replace `offset + limit` with `offset.saturating_add(limit)` to prevent overflow
- Apply to: `get_payments()` (payment-verifier), `get_usage()` (credit-escrow), `get_proposals()` (multisig)

## Files to Modify

| File | What |
|---|---|
| `contracts/payment-verifier/src/lib.rs` | Clamp `limit` in `get_payments`, add `saturating_add` |
| `contracts/credit-escrow/src/lib.rs` | Clamp `limit` in `get_usage`, add `saturating_add` |
| `contracts/multisig/src/lib.rs` | Clamp `limit` in `get_proposals`, add `saturating_add` |

## Acceptance Criteria

- [ ] `get_payments(offset=0, limit=u32::MAX)` returns at most 100 entries
- [ ] `get_usage(offset=0, limit=999999)` returns at most 100 entries
- [ ] `get_proposals(offset=0, limit=0)` returns 0 entries
- [ ] `offset.saturating_add(limit)` is used — no `u32` overflow possible
- [ ] Existing pagination tests still pass with adjusted expectations
- [ ] Add a test that passes `limit = u32::MAX` and verifies the clamp
- [ ] `cargo test` passes for all three contracts
ISSUEBODY

gh issue create \
  --title "fix(contracts): clamp unbounded limit in paginated queries to prevent gas DoS" \
  --label "bug,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:contracts,medium,security,bounty" \
  --body-file /tmp/issue3.md
echo "✓ Issue 3 created"

# ── Issue 4: Remove extend_ttl from Reads ───────────────────────────
cat > /tmp/issue4.md << 'ISSUEBODY'
## Problem

Every public function in all three contracts calls `extend_ttl()`, including read-only functions like `balance()`, `get_revenue()`, `get_usage()`, `is_payment_used()`, etc. This means:

1. **Arbitrary callers pay gas** for TTL extension on every read — unnecessary cost
2. A **frequently-called read** keeps the contract instance alive forever, even after abandonment
3. Reads should not extend TTL — only mutating functions that write storage should

## Scope

- Keep `extend_ttl()` only in mutating (write-path) functions: `deposit`, `withdraw`, `charge`, `refund`, `set_*`, `record_payment`, `propose`, `approve`, `set_signers`
- Remove `extend_ttl()` from all read-only functions: `balance`, `get_revenue`, `get_usage`, `is_payment_used`, `get_payment`, `get_payments`, `get_proposal`, `get_proposals`, `get_config`, `get_signers`

## Files to Modify

| File | What |
|---|---|
| `contracts/payment-verifier/src/lib.rs` | Remove `extend_ttl` from `is_payment_used`, `get_payment`, `get_payments` |
| `contracts/credit-escrow/src/lib.rs` | Remove `extend_ttl` from `balance`, `get_revenue`, `get_usage` |
| `contracts/multisig/src/lib.rs` | Remove `extend_ttl` from `get_proposal`, `get_proposals`, `get_config`, `get_signers` |

## Acceptance Criteria

- [ ] No `extend_ttl()` call in any read-only (non-mutating) contract function
- [ ] `extend_ttl()` still called in every mutating function (deposit, withdraw, charge, refund, record_payment, propose, approve, set_*, init)
- [ ] TTL survival tests still pass (TTL is extended on writes)
- [ ] `cargo test` passes for all three contracts
- [ ] Gas cost of `balance()` call is measurably lower than before
ISSUEBODY

gh issue create \
  --title "perf(contracts): remove extend_ttl from read-only functions to reduce unnecessary gas" \
  --label "enhancement,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:contracts,medium,bounty" \
  --body-file /tmp/issue4.md
echo "✓ Issue 4 created"

# ── Issue 5: Streaming Receipt Headers ─────────────────────────────
cat > /tmp/issue5.md << 'ISSUEBODY'
## Problem

Non-streaming responses include `X-Payment-Receipt`, `X-Actual-Cost`, and `X-Surplus` headers. The streaming path (`handleStreamingForward` in `proxy.service.ts`) sets only `X-Request-Trace-Id` — **never** the receipt or cost headers. The SDK's `callStream()` calls `parseReceiptHeader(response)` which returns `undefined` for streams, even though `success: true` is reported. This is a contract mismatch between the gateway and SDK.

## Scope

- In `handleStreamingForward`, after the stream completes via `onDone`, set `X-Payment-Receipt`, `X-Actual-Cost`, and `X-Surplus` headers on the response
- For streaming, these headers must be set **before** the response starts (since headers can't be modified after the body begins streaming). Estimate the receipt from the deposit and set preliminary headers; the final `X-Actual-Cost` can be logged or sent via a final SSE event
- Alternatively: send a final SSE event `[DONE]` with the receipt data as JSON (and document this in the SDK)

## Files to Modify

| File | What |
|---|---|
| `apps/gateway/src/modules/proxy/proxy.service.ts` | Set receipt/cost headers or final SSE event in `handleStreamingForward` |
| `packages/sdk/src/index.ts` | Update `callStream` to parse receipt from SSE event (if event approach is chosen) |
| `apps/gateway/src/e2e/x402-flow.e2e-spec.ts` | Add test coverage for streaming receipt |

## Acceptance Criteria

- [ ] Streaming responses include payment receipt information (either as headers set before streaming, or a final SSE event)
- [ ] SDK's `callStream()` returns a `cost` field with the actual cost (not `undefined`)
- [ ] Non-streaming path is unchanged
- [ ] E2E test verifies the receipt is present on streaming responses
- [ ] `pnpm exec nx test gateway` and `pnpm exec nx test gateway:test:e2e` pass
ISSUEBODY

gh issue create \
  --title "fix: set X-Payment-Receipt headers on streaming (SSE) responses" \
  --label "bug,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:gateway,area:sdk,medium,bounty" \
  --body-file /tmp/issue5.md
echo "✓ Issue 5 created"

# ── Issue 6: DNS Rebinding Protection ─────────────────────────────
cat > /tmp/issue6.md << 'ISSUEBODY'
## Problem

`validateUpstreamUrl()` in `webhooks.service.ts` resolves and validates the upstream hostname at **route configuration time** only. The proxy fetches the URL at request time without re-validating the resolved IP. A provider who controls a domain's DNS (or an attacker who compromises the zone) can rebind it to `169.254.169.254` (AWS/GCP metadata endpoint) or another internal IP **after** config validation passes. The webhook path re-validates at delivery time (good), but the upstream proxy path does not.

## Scope

- Add a DNS resolution + IP validation step inside the proxy fetch path (before the outgoing request)
- Cache validated IPs for 60 seconds keyed by hostname to avoid per-request DNS latency
- On validation failure, return 502 with a specific error message and log an audit event
- Ensure the cache is process-local (Map with TTL) — no Redis dependency needed

## Files to Modify

| File | What |
|---|---|
| `apps/gateway/src/modules/proxy/proxy.service.ts` | Add pre-fetch DNS re-validation with a local TTL cache |
| `apps/gateway/src/modules/webhooks/webhooks.service.ts` | Reuse/extract `isPublicIp` + DNS resolution into a shared utility if not already |

## Acceptance Criteria

- [ ] Upstream hostname is resolved and validated at request-forwarding time
- [ ] DNS results are cached for 60 seconds per hostname (subsequent requests to same host skip re-resolution)
- [ ] If validation fails (hostname now resolves to a private IP), the gateway returns 502 and does NOT forward the request
- [ ] A `proxy.dns_rebind_blocked` audit event is logged
- [ ] Existing tests pass; add a unit test that injects a mock DNS resolver returning a private IP
- [ ] `pnpm exec nx test gateway` passes
ISSUEBODY

gh issue create \
  --title "fix: re-validate upstream DNS at request time to prevent DNS rebinding SSRF" \
  --label "bug,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:gateway,medium,security,bounty" \
  --body-file /tmp/issue6.md
echo "✓ Issue 6 created"

# ── Issue 7: Enforce minPaymentAmount ──────────────────────────────
cat > /tmp/issue7.md << 'ISSUEBODY'
## Problem

`config.payment.minPaymentAmount` is defined in `.env.example` and loaded by `@x402/config`, but **neither quote generation nor payment verification uses it**. A route with `flatPrice=0` or a degenerate per-token config results in a `requiredAmount` of **1 stroop** (`1n`) — effectively free access.

## Scope

- In `generateQuote()`, reject or clamp quotes whose `requiredAmount < minPaymentAmount` (return an error or set the minimum)
- In `verifyStellarPayment()`, reject payments whose amount is below `minPaymentAmount`
- Default `minPaymentAmount` should be `10000` stroops (0.001 XLM) if not configured

## Files to Modify

| File | What |
|---|---|
| `apps/gateway/src/modules/x402/x402.service.ts` | Enforce minimum in `generateQuote` |
| `packages/x402-core/src/index.ts` | Enforce minimum in `verifyStellarPayment` |
| `packages/config/src/index.ts` | Ensure default value for `minPaymentAmount` |

## Acceptance Criteria

- [ ] Quotes with `requiredAmount < minPaymentAmount` are either rejected (400) or clamped to the minimum
- [ ] Payments below `minPaymentAmount` are rejected
- [ ] Default `minPaymentAmount = 10000` when env var is not set
- [ ] Unit tests cover: above-minimum (accepted), below-minimum (rejected), exactly-minimum (accepted)
- [ ] `pnpm exec nx test gateway` and `pnpm exec nx test x402-core` pass
ISSUEBODY

gh issue create \
  --title "fix: enforce minPaymentAmount config in quote generation and payment verification" \
  --label "bug,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:gateway,trivial,good first issue,bounty" \
  --body-file /tmp/issue7.md
echo "✓ Issue 7 created"

# ── Issue 8: Dashboard Unit Tests ──────────────────────────────────
cat > /tmp/issue8.md << 'ISSUEBODY'
## Problem

The Next.js dashboard has **zero unit tests**. The `apps/dashboard/project.json` target is lint-only with no `test` target. All 8 routes (`login`, `routes`, `payments`, `settings`, `webhooks`, `audit`, `error`, `loading`) and components (`sidebar`, `navbar`, `providers`) are untested. This is a coverage gap flagged in the project audit.

## Scope

- Add a `jest.config.ts` to `apps/dashboard` (use `@nx/jest` preset for Next.js)
- Add a `test` target to `apps/dashboard/project.json`
- Write basic smoke tests for at least 4 pages (render without crashing, handle loading/empty states)
- Write component tests for `Sidebar` (renders navigation links, highlights active route)
- Mock `@x402/database`, `next/navigation`, and wallet providers
- Set a `coverageThreshold` of at least 60% statements

## Files to Create/Modify

| File | What |
|---|---|
| `apps/dashboard/jest.config.ts` | Jest configuration for Next.js |
| `apps/dashboard/project.json` | Add `test` target |
| `apps/dashboard/src/**/*.spec.tsx` | New test files adjacent to pages/components |
| `apps/dashboard/src/app/routes/page.spec.tsx` | Routes page smoke test |
| `apps/dashboard/src/app/payments/page.spec.tsx` | Payments page smoke test |
| `apps/dashboard/src/components/layout/sidebar.spec.tsx` | Sidebar component test |

## Acceptance Criteria

- [ ] `pnpm exec nx test dashboard` runs and passes
- [ ] At least 4 page-level smoke tests exist
- [ ] `Sidebar` component has tests for link rendering and active route highlighting
- [ ] Tests mock external dependencies (`next/navigation`, wallet providers, API calls)
- [ ] `coverageThreshold` ≥ 60% statements for dashboard
- [ ] CI workflow (`ci.yml`) includes the dashboard test step
ISSUEBODY

gh issue create \
  --title "test: add Jest unit tests for dashboard pages and components" \
  --label "enhancement,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:dashboard,medium,good first issue,bounty" \
  --body-file /tmp/issue8.md
echo "✓ Issue 8 created"

# ── Issue 9: Wire Email Notifications ──────────────────────────────
cat > /tmp/issue9.md << 'ISSUEBODY'
## Problem

`EmailNotificationHandler.send()` in `packages/notifications/src/index.ts` just logs *"In production, this would use nodemailer"* and returns `true`. The handler is **never registered** in the default dispatcher — only `inAppHandler` is. Meanwhile, `.env.example` exposes `EMAIL_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, and `EMAIL_FROM` — config that does nothing.

## Scope

- Add `nodemailer` as a dependency to `packages/notifications`
- Implement `EmailNotificationHandler.send()` using nodemailer's `createTransport`
- Register the email handler in the notification dispatcher conditionally on `EMAIL_ENABLED`
- Read SMTP config from env vars (already loaded by `@x402/config`)
- Graceful degradation: if SMTP is unreachable, log a warning and don't crash

## Files to Modify

| File | What |
|---|---|
| `packages/notifications/src/index.ts` | Implement real email sending + register handler |
| `packages/notifications/package.json` | Add `nodemailer` + `@types/nodemailer` deps |

## Acceptance Criteria

- [ ] When `EMAIL_ENABLED=true`, notification events with email targets are delivered via SMTP
- [ ] When `EMAIL_ENABLED=false`, email handler is not registered (no-op)
- [ ] SMTP connection failures are caught and logged; the gateway does not crash
- [ ] Email subject/body include relevant event details (event type, payment amount, timestamp)
- [ ] Unit tests mock nodemailer transport and verify `sendMail` is called with correct params
- [ ] `pnpm exec nx test notifications` passes
- [ ] `pnpm install` succeeds with nodemailer added
ISSUEBODY

gh issue create \
  --title "feat: implement email notification channel with nodemailer" \
  --label "enhancement,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:notifications,medium,bounty" \
  --body-file /tmp/issue9.md
echo "✓ Issue 9 created"

# ── Issue 10: Escrow Accounting Invariant Tests ────────────────────
cat > /tmp/issue10.md << 'ISSUEBODY'
## Problem

The credit-escrow contract's test suite covers happy-path deposit/charge/refund/withdraw operations, but there are **no invariant tests** asserting that the contract's actual token balance always equals `sum(all_user_balances) + total_revenue + sum(all_refunds)`. The audit identified a potential edge case where `refund()` after `charge()` could leave `REVENUE` inconsistent with the held token balance if refund amounts exceed the uncharged portion.

## Scope

- Write a property-based (or exhaustive-walk) test that sequences deposit→charge→refund→withdraw_revenue operations
- After each operation, assert: `contract_token_balance == sum(user_balances) + revenue`
- Include edge cases: refund of uncharged deposit, refund of partially-charged deposit, withdraw while users have balances, deposit→charge→charge(idempotent)→refund
- If the test reveals an accounting bug, fix the contract

## Files to Modify

| File | What |
|---|---|
| `contracts/credit-escrow/src/lib.rs` | Add invariant test module (or extend existing tests) |

## Acceptance Criteria

- [ ] At least one invariant test that performs a multi-step sequence and asserts the balance equation after each step
- [ ] Test covers: deposit→charge→refund, deposit→refund(uncharged), deposit→charge→charge(idempotent), multi-user scenarios
- [ ] If the invariant fails, the contract code is fixed (not just the test)
- [ ] `cargo test -p credit-escrow` passes
- [ ] All existing 34 tests remain green
ISSUEBODY

gh issue create \
  --title "test(contracts): add invariant tests for credit-escrow token balance equation" \
  --label "enhancement,Stellar Wave,GrantFox OSS,Maybe Rewarded,area:contracts,medium,bounty" \
  --body-file /tmp/issue10.md
echo "✓ Issue 10 created"

echo ""
echo "══════════════════════════════════════════════"
echo "  All 10 issues created successfully!"
echo "══════════════════════════════════════════════"
