# Stellar Wave 8 / GrantFox — Curated Issues

> **18 well-scoped issues** spanning smart contracts (Rust/Soroban), gateway (NestJS), SDK (TypeScript), dashboard (Next.js), and security hardening.  
> Each issue includes labels, complexity, acceptance criteria, and file-level pointers so contributors can start immediately.

---

## Issue 1: Wire Credit Escrow Settlement in the Gateway

**GitHub:** [#25](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/25) · **Status:** ✅ implemented — gateway settlement wiring, disabled-warning, unit + e2e tests (2026-09-09)

**Title:** `feat: wire credit-escrow settlement for metered per-token pricing`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `area:contracts` `priority:high`

**Complexity:** High (200 pts)

### Problem

Per-token pricing detects underpayment (`applyMeteredPricing` logs `isUnderpaid`) but **never settles** via the on-chain credit-escrow contract. The `ESCROW_SETTLEMENT_ENABLED` config flag exists but no gateway code calls `charge()` / `refund()`. The README claims "gateway charges actual cost from the caller's escrow balance and auto-refunds surplus" — this doesn't work.

### Scope

- Gate the settlement path behind `escrowSettlementEnabled` config (default `false`)
- After a metered LLM response completes, call `credit-escrow.charge(user, quoteId, actualCost)` to deduct actual usage
- Call `credit-escrow.refund(user, quoteId, surplus)` for any unused deposit
- Add a `contract-client.ts` counterpart for the credit-escrow contract (or extend the existing `contract-client.ts`)
- Log a warning (not error) when `escrowSettlementEnabled=false` and a per-token route is used

### Files to Modify

| File                                               | What                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/gateway/src/modules/x402/contract-client.ts` | Add `chargeEscrow()`, `refundEscrow()` helpers                                  |
| `apps/gateway/src/modules/x402/x402.service.ts`    | Call settlement after metered pricing calc                                      |
| `apps/gateway/src/modules/proxy/proxy.service.ts`  | Wire settlement into the response path                                          |
| `contracts/credit-escrow/src/lib.rs`               | Reference only — existing `charge`/`refund`/`get_usage` are already implemented |

### Acceptance Criteria

- [ ] When `ESCROW_SETTLEMENT_ENABLED=true`, a per-token request that completes successfully calls `charge(user, quoteId, actualCost)` on-chain
- [ ] Surplus deposits trigger `refund(user, quoteId, surplus)` on-chain
- [ ] When `ESCROW_SETTLEMENT_ENABLED=false`, the gateway logs a warning and skips settlement (no crash)
- [ ] Settlement calls are idempotent (contract already supports this — verify no double-charge)
- [ ] Unit tests cover both enabled/disabled paths (`x402.service.spec.ts`)
- [ ] E2E test covers the settlement flow (mock the contract client)
- [ ] `pnpm exec nx test gateway` passes with 100% of new code covered

---

## Issue 2: Implement SDK External Signer (`signTransaction` callback)

**GitHub:** [#26](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/26) · **Status:** ✅ implemented — external signer path + error-path tests (2026-09-09)

**Title:** `fix: implement external signer path in SDK executePayment`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:sdk` `priority:high`

**Complexity:** Medium (150 pts)

### Problem

`X402Client.executePayment()` contains a stub that always returns an error when an external `signTransaction` callback is provided:

```ts
if (this.config.signTransaction) {
  return {
    success: false,
    error: 'External wallet signing not yet implemented — provide a secretKey',
  };
}
```

The README and `@x402/types` advertise "Stellar wallet integration (secret key or external signer)", but external signers (Freighter, xBull, Albedo — the primary integration path for browser/agent apps) are **broken by design**.

### Scope

- Build the transaction via the existing `buildPaymentTransaction` helper
- When `signTransaction` is provided, call it with the `txXdr` (base64-encoded transaction envelope)
- Submit the signed XDR to Horizon
- Poll for confirmation (reuse existing polling logic)
- Return the confirmed transaction hash

### Files to Modify

| File                          | What                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `packages/sdk/src/index.ts`   | Replace the stub in `executePayment()` with real implementation |
| `packages/types/src/index.ts` | Verify `signTransaction` callback signature is correct          |

### Acceptance Criteria

- [ ] `X402Client` with `signTransaction` callback (no `secretKey`) calls the callback with a valid `txXdr`
- [ ] The signed XDR is submitted to Horizon and confirmed
- [ ] The returned `PaymentResult` matches the same shape as the `secretKey` path
- [ ] Error handling: invalid XDR, rejected signing, failed submission all return `{ success: false, error: string }`
- [ ] Existing `secretKey` path continues to work unchanged
- [ ] Unit tests for both `secretKey` and `signTransaction` paths
- [ ] `pnpm exec nx test sdk` passes (add Jest config if missing)

---

## Issue 3: Clamp Unbounded Pagination Limits in Soroban Contracts

**GitHub:** [#27](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/27) · **Status:** ✅ implemented — MAX_PAGE_SIZE clamp + saturating_add in all three contracts, clamp/overflow tests + property tests + gas benches (2026-09-09)

**Title:** `fix(contracts): clamp unbounded limit in paginated queries to prevent gas DoS`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:contracts` `priority:medium` `security`

**Complexity:** Medium (150 pts)

### Problem

All three contracts (`payment-verifier`, `credit-escrow`, `multisig`) paginate with:

```rust
let end = (offset + limit).min(count);
for i in offset..end { ... }
```

A caller can pass `limit = u32::MAX` and `offset = 0` — the loop iterates up to `count` entries, which is a predictable gas-exhaustion / archive-read DoS vector. Additionally, `offset + limit` can overflow `u32` (panics in debug, wraps in release).

### Scope

- Add `.min(100)` clamp on `limit` in each paginated function
- Replace `offset + limit` with `offset.saturating_add(limit)` to prevent overflow
- Apply to: `get_payments()` (payment-verifier), `get_usage()` (credit-escrow), `get_proposals()` (multisig)

### Files to Modify

| File                                    | What                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| `contracts/payment-verifier/src/lib.rs` | Clamp `limit` in `get_payments`, add `saturating_add`  |
| `contracts/credit-escrow/src/lib.rs`    | Clamp `limit` in `get_usage`, add `saturating_add`     |
| `contracts/multisig/src/lib.rs`         | Clamp `limit` in `get_proposals`, add `saturating_add` |

### Acceptance Criteria

- [ ] `get_payments(offset=0, limit=u32::MAX)` returns at most 100 entries
- [ ] `get_usage(offset=0, limit=999999)` returns at most 100 entries
- [ ] `get_proposals(offset=0, limit=0)` returns 0 entries
- [ ] `offset.saturating_add(limit)` is used — no `u32` overflow possible
- [ ] Existing pagination tests still pass with adjusted expectations
- [ ] Add a test that passes `limit = u32::MAX` and verifies the clamp
- [ ] `cargo test` passes for all three contracts

---

## Issue 4: Remove `extend_ttl` from Read-Only Soroban Contract Functions

**GitHub:** [#28](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/28) · **Status:** open

**Title:** `perf(contracts): remove extend_ttl from read-only functions to reduce unnecessary gas costs`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:contracts` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

Every public function in all three contracts calls `extend_ttl()`, including read-only functions like `balance()`, `get_revenue()`, `get_usage()`, `is_payment_used()`, etc. This means:

1. **Arbitrary callers pay gas** for TTL extension on every read — unnecessary cost
2. A **frequently-called read** keeps the contract instance alive forever, even after abandonment
3. Reads should not extend TTL — only mutating functions that write storage should

### Scope

- Keep `extend_ttl()` only in mutating (write-path) functions: `deposit`, `withdraw`, `charge`, `refund`, `set_*`, `record_payment`, `propose`, `approve`, `set_signers`
- Remove `extend_ttl()` from all read-only functions: `balance`, `get_revenue`, `get_usage`, `is_payment_used`, `get_payment`, `get_payments`, `get_proposal`, `get_proposals`, `get_config`, `get_signers`

### Files to Modify

| File                                    | What                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `contracts/payment-verifier/src/lib.rs` | Remove `extend_ttl` from `is_payment_used`, `get_payment`, `get_payments`             |
| `contracts/credit-escrow/src/lib.rs`    | Remove `extend_ttl` from `balance`, `get_revenue`, `get_usage`                        |
| `contracts/multisig/src/lib.rs`         | Remove `extend_ttl` from `get_proposal`, `get_proposals`, `get_config`, `get_signers` |

### Acceptance Criteria

- [ ] No `extend_ttl()` call in any read-only (non-mutating) contract function
- [ ] `extend_ttl()` still called in every mutating function (deposit, withdraw, charge, refund, record_payment, propose, approve, set_*, init)
- [ ] TTL survival tests still pass (TTL is extended on writes)
- [ ] `cargo test` passes for all three contracts
- [ ] Gas cost of `balance()` call is measurably lower than before

---

## Issue 5: Add Payment Receipt Headers to Streaming (SSE) Responses

**GitHub:** [#29](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/29) · **Status:** open

**Title:** `fix: set X-Payment-Receipt headers on streaming responses`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `area:sdk` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

Non-streaming responses include `X-Payment-Receipt`, `X-Actual-Cost`, and `X-Surplus` headers. The streaming path (`handleStreamingForward`) sets only `X-Request-Trace-Id` — **never** the receipt or cost headers. The SDK's `callStream()` calls `parseReceiptHeader(response)` which returns `undefined` for streams, even though `success: true` is reported. This is a contract mismatch between the gateway and SDK.

### Scope

- In `handleStreamingForward`, after the stream completes via `onDone`, set `X-Payment-Receipt`, `X-Actual-Cost`, and `X-Surplus` headers on the response
- For streaming, these headers must be set **before** the response starts (since headers can't be modified after the body begins streaming). Estimate the receipt from the deposit and set preliminary headers; the final `X-Actual-Cost` can be logged or sent via a final SSE event
- Alternatively: send a final SSE event `[DONE]` with the receipt data as JSON (and document this in the SDK)

### Files to Modify

| File                                              | What                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/gateway/src/modules/proxy/proxy.service.ts` | Set receipt/cost headers or final SSE event in `handleStreamingForward`           |
| `packages/sdk/src/index.ts`                       | Update `callStream` to parse receipt from SSE event (if event approach is chosen) |
| `apps/gateway/src/e2e/x402-flow.e2e-spec.ts`      | Add test coverage for streaming receipt                                           |

### Acceptance Criteria

- [ ] Streaming responses include payment receipt information (either as headers set before streaming, or a final SSE event)
- [ ] SDK's `callStream()` returns a `cost` field with the actual cost (not `undefined`)
- [ ] Non-streaming path is unchanged
- [ ] E2E test verifies the receipt is present on streaming responses
- [ ] `pnpm exec nx test gateway` and `pnpm exec nx test gateway:test:e2e` pass

---

## Issue 6: Add DNS Rebinding Protection at Proxy-Forward Time

**GitHub:** [#30](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/30) · **Status:** ✅ closed — implemented in `813fed7`

**Title:** `fix: re-validate upstream DNS at request time to prevent DNS rebinding SSRF`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `priority:medium` `security`

**Complexity:** Medium (150 pts)

### Problem

`validateUpstreamUrl()` in `webhooks.service.ts` resolves and validates the upstream hostname at **route configuration time** only. The proxy fetches the URL at request time without re-validating the resolved IP. A provider who controls a domain's DNS (or an attacker who compromises the zone) can rebind it to `169.254.169.254` (AWS/GCP metadata endpoint) or another internal IP **after** config validation passes. The webhook path re-validates at delivery time (good), but the upstream proxy path does not.

### Scope

- Add a DNS resolution + IP validation step inside the proxy fetch path (before the outgoing request)
- Cache validated IPs for 60 seconds keyed by hostname to avoid per-request DNS latency
- On validation failure, return 502 with a specific error message and log an audit event
- Ensure the cache is process-local (Map with TTL) — no Redis dependency needed

### Files to Modify

| File                                                    | What                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/gateway/src/modules/proxy/proxy.service.ts`       | Add pre-fetch DNS re-validation with a local TTL cache                           |
| `apps/gateway/src/modules/webhooks/webhooks.service.ts` | Reuse/extract `isPublicIp` + DNS resolution into a shared utility if not already |

### Acceptance Criteria

- [ ] Upstream hostname is resolved and validated at request-forwarding time
- [ ] DNS results are cached for 60 seconds per hostname (subsequent requests to same host skip re-resolution)
- [ ] If validation fails (hostname now resolves to a private IP), the gateway returns 502 and does NOT forward the request
- [ ] A `proxy.dns_rebind_blocked` audit event is logged
- [ ] Existing tests pass; add a unit test that injects a mock DNS resolver returning a private IP
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 7: Enforce `minPaymentAmount` in Quote Generation and Payment Verification

**GitHub:** [#31](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/31) · **Status:** open

**Title:** `fix: enforce minPaymentAmount config in quote generation and payment verification`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `priority:medium` `good first issue`

**Complexity:** Trivial (100 pts)

### Problem

`config.payment.minPaymentAmount` is defined in `.env.example` and loaded by `@x402/config`, but **neither quote generation nor payment verification uses it**. A route with `flatPrice=0` or a degenerate per-token config results in a `requiredAmount` of **1 stroop** (`1n`) — effectively free access.

### Scope

- In `generateQuote()`, reject or clamp quotes whose `requiredAmount < minPaymentAmount` (return an error or set the minimum)
- In `verifyStellarPayment()`, reject payments whose amount is below `minPaymentAmount`
- Default `minPaymentAmount` should be `10000` stroops (0.001 XLM) if not configured

### Files to Modify

| File                                            | What                                        |
| ----------------------------------------------- | ------------------------------------------- |
| `apps/gateway/src/modules/x402/x402.service.ts` | Enforce minimum in `generateQuote`          |
| `packages/x402-core/src/index.ts`               | Enforce minimum in `verifyStellarPayment`   |
| `packages/config/src/index.ts`                  | Ensure default value for `minPaymentAmount` |

### Acceptance Criteria

- [ ] Quotes with `requiredAmount < minPaymentAmount` are either rejected (400) or clamped to the minimum
- [ ] Payments below `minPaymentAmount` are rejected
- [ ] Default `minPaymentAmount = 10000` when env var is not set
- [ ] Unit tests cover: above-minimum (accepted), below-minimum (rejected), exactly-minimum (accepted)
- [ ] `pnpm exec nx test gateway` and `pnpm exec nx test x402-core` pass

---

## Issue 8: Add Unit Tests for Next.js Dashboard

**GitHub:** [#32](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/32) · **Status:** ✅ closed — initial scaffolding in `05e10c9` (page-level tests + CI step remain as follow-up)

**Title:** `test: add Jest unit tests for dashboard pages and components`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:dashboard` `priority:medium` `good first issue`

**Complexity:** Medium (150 pts)

### Problem

The Next.js dashboard has **zero unit tests**. The `apps/dashboard/project.json` target is lint-only with no `test` target. All 8 routes (`login`, `routes`, `payments`, `settings`, `webhooks`, `audit`, `error`, `loading`) and components (`sidebar`, `navbar`, `providers`) are untested. This is a coverage gap flagged in the project audit.

### Scope

- Add a `jest.config.ts` to `apps/dashboard` (use `@nx/jest` preset for Next.js)
- Add a `test` target to `apps/dashboard/project.json`
- Write basic smoke tests for at least 4 pages (render without crashing, handle loading/empty states)
- Write component tests for `Sidebar` (renders navigation links, highlights active route)
- Mock `@x402/database`, `next/navigation`, and wallet providers
- Set a `coverageThreshold` of at least 60% statements

### Files to Create/Modify

| File                                                    | What                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| `apps/dashboard/jest.config.ts`                         | Jest configuration for Next.js              |
| `apps/dashboard/project.json`                           | Add `test` target                           |
| `apps/dashboard/src/**/*.spec.tsx`                      | New test files adjacent to pages/components |
| `apps/dashboard/src/app/routes/page.spec.tsx`           | Routes page smoke test                      |
| `apps/dashboard/src/app/payments/page.spec.tsx`         | Payments page smoke test                    |
| `apps/dashboard/src/components/layout/sidebar.spec.tsx` | Sidebar component test                      |

### Acceptance Criteria

- [ ] `pnpm exec nx test dashboard` runs and passes
- [ ] At least 4 page-level smoke tests exist
- [ ] `Sidebar` component has tests for link rendering and active route highlighting
- [ ] Tests mock external dependencies (`next/navigation`, wallet providers, API calls)
- [ ] `coverageThreshold` ≥ 60% statements for dashboard
- [ ] CI workflow (`ci.yml`) includes the dashboard test step

---

## Issue 9: Wire Email Notification Channel

**GitHub:** [#33](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/33) · **Status:** ✅ closed — implemented in `09e4706` (dispatcher registration remains as follow-up in #43 scope)

**Title:** `feat: implement email notification channel with nodemailer`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:notifications` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

`EmailNotificationHandler.send()` in `packages/notifications/src/index.ts` just logs _"In production, this would use nodemailer"_ and returns `true`. The handler is **never registered** in the default dispatcher — only `inAppHandler` is. Meanwhile, `.env.example` exposes `EMAIL_ENABLED`, `SMTP_HOST`, `SMTP_PORT`, and `EMAIL_FROM` — config that does nothing.

### Scope

- Add `nodemailer` as a dependency to `packages/notifications`
- Implement `EmailNotificationHandler.send()` using nodemailer's `createTransport`
- Register the email handler in the notification dispatcher conditionally on `EMAIL_ENABLED`
- Read SMTP config from env vars (already loaded by `@x402/config`)
- Graceful degradation: if SMTP is unreachable, log a warning and don't crash

### Files to Modify

| File                                  | What                                            |
| ------------------------------------- | ----------------------------------------------- |
| `packages/notifications/src/index.ts` | Implement real email sending + register handler |
| `packages/notifications/package.json` | Add `nodemailer` + `@types/nodemailer` deps     |

### Acceptance Criteria

- [ ] When `EMAIL_ENABLED=true`, notification events with email targets are delivered via SMTP
- [ ] When `EMAIL_ENABLED=false`, email handler is not registered (no-op)
- [ ] SMTP connection failures are caught and logged; the gateway does not crash
- [ ] Email subject/body include relevant event details (event type, payment amount, timestamp)
- [ ] Unit tests mock nodemailer transport and verify `sendMail` is called with correct params
- [ ] `pnpm exec nx test notifications` passes
- [ ] `pnpm install` succeeds with nodemailer added

---

## Issue 10: Add Escrow Accounting Invariant Tests

**GitHub:** [#34](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/34) · **Status:** ✅ closed — implemented in `b49a2d1`

**Title:** `test(contracts): add invariant tests for credit-escrow token balance equation`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:contracts` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

The credit-escrow contract's test suite covers happy-path deposit/charge/refund/withdraw operations, but there are **no invariant tests** asserting that the contract's actual token balance always equals `sum(all_user_balances) + total_revenue + sum(all_refunds)`. The audit identified a potential edge case where `refund()` after `charge()` could leave `REVENUE` inconsistent with the held token balance if refund amounts exceed the uncharged portion.

### Scope

- Write a property-based (or exhaustive-walk) test that sequences deposit→charge→refund→withdraw_revenue operations
- After each operation, assert: `contract_token_balance == sum(user_balances) + revenue`
- Include edge cases: refund of uncharged deposit, refund of partially-charged deposit, withdraw while users have balances, deposit→charge→charge(idempotent)→refund
- If the test reveals an accounting bug, fix the contract

### Files to Modify

| File                                 | What                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `contracts/credit-escrow/src/lib.rs` | Add invariant test module (or extend existing tests) |

### Acceptance Criteria

- [ ] At least one invariant test that performs a multi-step sequence and asserts the balance equation after each step
- [ ] Test covers: deposit→charge→refund, deposit→refund(uncharged), deposit→charge→charge(idempotent), multi-user scenarios
- [ ] If the invariant fails, the contract code is fixed (not just the test)
- [ ] `cargo test -p credit-escrow` passes
- [ ] All existing 34 tests remain green

---

## Issue 11: Automate Provider Payouts via the Multisig Soroban Contract

**GitHub:** [#40](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/40) · **Status:** ✅ implemented — multisig-client, PayoutProposal model/migration, payout service + admin endpoints, threshold-1 auto-approve, unit tests (2026-09-09)

**Title:** `feat: automate provider payouts via the multisig Soroban contract`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `area:contracts` `priority:high`

**Complexity:** High (200 pts)

### Problem

The `multisig` Soroban contract (`contracts/multisig`) implements `propose` / `approve` / `set_signers` with M-of-N threshold enforcement, and its deployed address is already wired into `@x402/config` — but **no gateway code ever calls it**. Provider revenue accrues in Postgres (`Payment` rows) with no automated path to pay providers out through the multisig wallet. The README roadmap lists "Provider payout automation via multisig contracts" as in-progress; the audit (M4) flags the missing trust-model wiring.

### Scope

- Add `apps/gateway/src/modules/x402/multisig-client.ts` mirroring the existing `escrow-client.ts` (propose, approve, get_proposal, get_config)
- Add a payout service: given a provider's confirmed revenue, propose a payout to `provider.payoutWalletAddress`
- Admin endpoints: `POST /api/v1/admin/payouts/propose`, `GET /api/v1/admin/payouts`, `POST /api/v1/admin/payouts/:id/approve`
- Gate behind a `PAYOUT_AUTOMATION_ENABLED` config flag (default `false`) + `CONTRACT_ADMIN_SECRET`, mirroring `escrowSettlementEnabled`
- For threshold 1, approve automatically; for higher thresholds expose proposals in the dashboard for signer approval

### Files to Modify

| File                                                 | What                                                |
| ---------------------------------------------------- | --------------------------------------------------- |
| `apps/gateway/src/modules/x402/multisig-client.ts`   | New — multisig contract client                      |
| `apps/gateway/src/modules/admin/admin.service.ts`    | Payout proposal orchestration                       |
| `apps/gateway/src/modules/admin/admin.controller.ts` | Payout endpoints                                    |
| `packages/config/src/index.ts`                       | `payoutAutomationEnabled` flag                      |
| `contracts/multisig/src/lib.rs`                      | Reference — `propose`/`approve` already implemented |

### Acceptance Criteria

- [ ] `multisig-client.ts` can propose/approve against a deployed testnet contract (or is fully mocked)
- [ ] Pending provider revenue is computed from `Payment` rows, wallet-scoped
- [ ] Payouts are only visible to the provider owner's wallet
- [ ] `PAYOUT_AUTOMATION_ENABLED=false` → no crash, no contract calls
- [ ] Unit tests with a mocked contract client cover propose/approve/list
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 12: Require Explicit `TRUST_PROXY` and Add Wallet-Based Rate Limiting for the Paid Tier

**GitHub:** [#41](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/41) · **Status:** open

**Title:** `fix: require explicit TRUST_PROXY and add wallet-based rate limiting for the paid tier`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `priority:medium` `security`

**Complexity:** Medium (150 pts)

### Problem

`RateLimitGuard` identifies callers **by IP only**, and `@x402/config` defaults `TRUST_PROXY=1`. When the gateway is directly exposed (local dev, some VPS/Railway configs, Docker without a reverse proxy), Express trusts the left-most `X-Forwarded-For` hop — a client can spoof that header and **rotate IPs to bypass both paid and unpaid rate limits**. The audit (M7) flags this as a config-time security trap.

### Scope

- Make the trust-proxy decision explicit: fail fast or log a prominent startup warning when `TRUST_PROXY` is unset and `NODE_ENV=production`
- Add optional `RATE_LIMIT_BY_WALLET=true`: for confirmed paid requests, key the paid tier by the payer's wallet address (from the confirmed payment row) instead of IP
- Document the trust model in `SECURITY.md` and `.env.example`

### Files to Modify

| File                                                 | What                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| `packages/config/src/index.ts`                       | Default + production validation for `TRUST_PROXY` |
| `apps/gateway/src/common/guards/rate-limit.guard.ts` | Wallet-keyed paid tier option                     |
| `apps/gateway/src/main.ts`                           | Startup warning when trust proxy is misconfigured |
| `.env.example` / `SECURITY.md`                       | Guidance                                          |

### Acceptance Criteria

- [ ] Production startup with unset `TRUST_PROXY` fails fast (or logs a prominent warning)
- [ ] `RATE_LIMIT_BY_WALLET=true` keys the paid tier by wallet address
- [ ] Spoofed `X-Forwarded-For` no longer bypasses limits in the default direct-exposure path
- [ ] Unit tests for both IP-keyed and wallet-keyed paths
- [ ] `pnpm exec nx test gateway` and `pnpm exec nx test config` pass

---

## Issue 13: Validate Payout Wallets and Add an Optional Provider Approval Flow

**GitHub:** [#42](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/42) · **Status:** open

**Title:** `feat: validate payout wallets and add an optional provider approval flow`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `priority:medium` `security`

**Complexity:** Medium (150 pts)

### Problem

`ProvidersService.create()` stores `payoutWalletAddress` **as-is with zero validation** — no Stellar address format check, no check that it differs from the auth wallet, no check the account exists. Any authenticated wallet can create a provider pointing routes at any public LLM endpoint, and a typo'd payout address would burn future payouts. The audit (M4) flags this trust-model gap.

### Scope

- Validate `payoutWalletAddress` (when set) with `StrKey.isValidEd25519PublicKey` from `@stellar/stellar-sdk` — reject invalid addresses with 400
- Reject `payoutWalletAddress === walletAddress` by default (payout wallet must differ from the auth wallet), with an explicit opt-out flag
- Optional `PROVIDER_APPROVAL_REQUIRED=true`: new providers start `active: false` and require an admin approve endpoint to activate
- Update the dashboard provider form to surface validation errors

### Files to Modify

| File                                                         | What                                 |
| ------------------------------------------------------------ | ------------------------------------ |
| `apps/gateway/src/modules/providers/providers.service.ts`    | Address validation + approval gating |
| `apps/gateway/src/modules/providers/providers.controller.ts` | Approve endpoint                     |
| `packages/config/src/index.ts`                               | New flags                            |
| `packages/validation/src/index.ts`                           | Zod schema for payout address        |
| `apps/dashboard/src/app/providers/page.tsx`                  | Error surfacing                      |

### Acceptance Criteria

- [ ] Invalid payout address → 400 with a clear message
- [ ] Same-as-auth-wallet rejected by default
- [ ] Approval-required mode: new providers inactive until approved
- [ ] Dashboard shows field-level validation errors
- [ ] Unit tests cover valid/invalid/same addresses
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 14: Persist In-App Notifications in Postgres (Durable, Cross-Instance)

**GitHub:** [#43](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/43) · **Status:** open

**Title:** `feat: persist in-app notifications in Postgres (durable, cross-instance)`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:notifications` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

`inAppHandler` in `packages/notifications` keeps a **module-level in-memory array** capped at 1,000 messages. Notifications are lost on restart, invisible across gateway instances, and only reachable via package-local helpers — the dashboard has no read/read-mark API. The audit (L8) flags this as a durability/scale gap.

### Scope

- Add an `InAppNotification` model to `packages/database/prisma/schema.prisma` (providerId, event, data JSON, read, createdAt) + migration
- Rewrite `inAppHandler` to persist to Postgres when `DATABASE_URL` is available (keep in-memory fallback for tests/no-DB)
- Gateway endpoints: `GET /api/v1/notifications` (paginated, wallet-scoped) and `POST /api/v1/notifications/:id/read`
- Dashboard badge showing unread count

### Files to Modify

| File                                         | What                                                |
| -------------------------------------------- | --------------------------------------------------- |
| `packages/database/prisma/schema.prisma`     | `InAppNotification` model + migration               |
| `packages/notifications/src/index.ts`        | DB-backed handler                                   |
| `apps/gateway/src/modules/notifications/`    | New module (controller + service) — or extend admin |
| `apps/dashboard/src/app/layout.tsx` / navbar | Unread badge                                        |

### Acceptance Criteria

- [ ] Notifications survive a gateway restart
- [ ] Read/unread state is per-provider and wallet-scoped
- [ ] Pagination works (limit 50 default)
- [ ] In-memory fallback preserved when no DB
- [ ] Migration applies cleanly (`prisma migrate dev`)
- [ ] Unit tests for the DB handler + endpoints
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 15: Move Analytics Time-Series Bucketing from JS to SQL

**GitHub:** [#44](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/44) · **Status:** open

**Title:** `perf: move analytics time-series bucketing from JS to SQL`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `area:gateway` `priority:medium` `good first issue`

**Complexity:** Medium (150 pts)

### Problem

`AnalyticsService.getTimeSeries()` fetches **every event in the time window** with `findMany` and buckets in Node.js. At scale this loads unbounded rows into memory per dashboard view. The audit (L10) flags this as a scalability gap; the summary endpoint already uses aggregate queries and should be the model.

### Scope

- Rewrite `getTimeSeries` using a single Postgres aggregation: `date_trunc('minute', createdAt)` + `GROUP BY` via `prisma.$queryRaw` (or `groupBy` where Prisma supports it)
- Preserve the exact `TimeSeriesDataPoint[]` shape and zero-filled bucket boundaries
- Keep the existing wallet-scoping ownership checks

### Files to Modify

| File                                                           | What                              |
| -------------------------------------------------------------- | --------------------------------- |
| `apps/gateway/src/modules/analytics/analytics.service.ts`      | SQL bucketing for `getTimeSeries` |
| `apps/gateway/src/modules/analytics/analytics.service.spec.ts` | Tests with mocked Prisma          |

### Acceptance Criteria

- [ ] `getTimeSeries` issues one SQL query — no unbounded `findMany`
- [ ] Response shape identical to today (bucket timestamps, counts, revenue string)
- [ ] Empty windows still return zero-filled buckets
- [ ] Unit tests cover multi-bucket aggregation and empty windows
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 16: Add Unit Tests for `@x402/sdk` (call, streaming, signer paths)

**GitHub:** [#45](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/45) · **Status:** ✅ implemented — SDK unit suite (19 tests, 89.9% stmts) covering call/stream/signer paths + error paths, threshold enforced in CI (2026-09-09)

**Title:** `test: add unit tests for @x402/sdk (call, streaming, signer paths)`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `good first issue` `area:sdk` `priority:medium`

**Complexity:** Medium (150 pts)

### Problem

`@x402/sdk` — the primary client integration surface — has **zero unit tests**: no spec file, no `test` target in `project.json`, no Jest config. The 402→pay→retry flow, SSE streaming, and both signer paths are only exercised indirectly. The audit (L9) flags this gap.

### Scope

- Add `packages/sdk/jest.config.ts` + a `test` target to `project.json` (reuse the repo's `@nx/jest` preset)
- Mock `fetch` and `@x402/wallet` to test:
  - `call()`: 200 path, 402→pay→retry, quote expiry, wrong-asset rejection, gateway errors
  - `callStream()`: SSE chunk parsing, `x402_receipt` trailing event, `[DONE]` termination
  - `executePayment`: `secretKey` path and external `signTransaction` path
  - `checkPaymentStatus`
- Enforce a coverage threshold consistent with other packages (≥ 80% statements)

### Files to Modify

| File                             | What                    |
| -------------------------------- | ----------------------- |
| `packages/sdk/src/index.spec.ts` | New test suite          |
| `packages/sdk/jest.config.ts`    | New Jest config         |
| `packages/sdk/project.json`      | `test` target           |
| `packages/sdk/package.json`      | Test devDeps if missing |

### Acceptance Criteria

- [ ] `pnpm exec nx test sdk` passes
- [ ] 402→pay→retry covered end-to-end at the SDK level (mocked network)
- [ ] Streaming receipt parsing covered
- [ ] Both `secretKey` and `signTransaction` paths covered
- [ ] Coverage threshold enforced in CI

---

## Issue 17: Populate Route in Payment Receipts

**GitHub:** [#46](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/46) · **Status:** open

**Title:** `fix: populate route in payment receipts (X-Payment-Receipt shows empty route)`

**Labels:** `bug` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `good first issue` `area:gateway` `trivial`

**Complexity:** Trivial (100 pts)

### Problem

`PaymentsService.confirmPayment()` builds the receipt with `route: ''` and a comment saying "populated by the caller" — but **no caller populates it**. Every `X-Payment-Receipt` header therefore reports an empty route, and the stored `receiptJson` is wrong. The audit (L7) flags this as a data-quality bug.

### Scope

- Resolve the route path from the pending payment's `routeId` (join `Route`) at confirmation time
- Populate `receipt.route` with the actual path (e.g. `/v1/chat/completions`)
- Update `recordActualCost` receipt merge if needed
- Add/update a unit test asserting a non-empty route

### Files to Modify

| File                                                         | What                                 |
| ------------------------------------------------------------ | ------------------------------------ |
| `apps/gateway/src/modules/payments/payments.service.ts`      | Populate `route` in `confirmPayment` |
| `apps/gateway/src/modules/payments/payments.service.spec.ts` | Assert route populated               |

### Acceptance Criteria

- [ ] Confirmed receipts include the real route path
- [ ] Stored `receiptJson` and returned header both have a non-empty route
- [ ] Unit test covers it
- [ ] `pnpm exec nx test gateway` passes

---

## Issue 18: Remove Unused `Session` and `ApiKey` Prisma Models

**GitHub:** [#47](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/47) · **Status:** open

**Title:** `chore: remove unused Session and ApiKey Prisma models`

**Labels:** `enhancement` `Stellar Wave` `GrantFox OSS` `Maybe Rewarded` `good first issue` `area:gateway` `trivial`

**Complexity:** Trivial (100 pts)

### Problem

The Prisma schema defines `Session` and `ApiKey` models, but neither is used: sessions live in Redis (`AuthStore`), and no code path reads or writes `ApiKey`. The audit (L1) flags these as dead tables that add migration surface and confuse contributors.

### Scope

- Grep the repo to confirm zero references to `prisma.session` / `prisma.apiKey` in gateway, dashboard, and packages
- Remove the models from `packages/database/prisma/schema.prisma`
- Generate and apply a migration that drops the tables
- Update the README "Database Schema" table if it lists them

### Files to Modify

| File                                     | What                               |
| ---------------------------------------- | ---------------------------------- |
| `packages/database/prisma/schema.prisma` | Remove `Session` / `ApiKey` models |
| `packages/database/prisma/migrations/`   | Drop-tables migration              |
| `README.md`                              | Schema table                       |

### Acceptance Criteria

- [ ] Zero references to the removed models remain in code
- [ ] Migration drops `Session` and `ApiKey` cleanly
- [ ] `prisma generate` succeeds and the gateway compiles
- [ ] Existing tests pass

---

## Summary

| #   | Issue                                       | Area                | Complexity | Status  | Labels                                             |
| --- | ------------------------------------------- | ------------------- | ---------- | ------- | -------------------------------------------------- |
| 1   | Wire credit-escrow settlement               | gateway + contracts | High       | open    | `enhancement` `priority:high`                      |
| 2   | SDK external signer                         | SDK                 | Medium     | open    | `bug` `priority:high`                              |
| 3   | Clamp unbounded pagination limits           | contracts           | Medium     | open    | `bug` `security` `priority:medium`                 |
| 4   | Remove extend_ttl from reads                | contracts           | Medium     | open    | `enhancement` `priority:medium`                    |
| 5   | Streaming receipt headers                   | gateway + SDK       | Medium     | open    | `bug` `priority:medium`                            |
| 6   | DNS rebinding protection at proxy time      | gateway             | Medium     | ✅ done | `bug` `security` `priority:medium`                 |
| 7   | Enforce minPaymentAmount                    | gateway + x402-core | Trivial    | open    | `bug` `priority:medium` `good first issue`         |
| 8   | Dashboard unit tests                        | dashboard           | Medium     | ✅ done | `enhancement` `priority:medium` `good first issue` |
| 9   | Wire email notification channel             | notifications       | Medium     | ✅ done | `enhancement` `priority:medium`                    |
| 10  | Escrow accounting invariant tests           | contracts           | Medium     | ✅ done | `enhancement` `priority:medium`                    |
| 11  | Multisig payout automation                  | gateway + contracts | High       | open    | `enhancement` `priority:high`                      |
| 12  | Explicit TRUST_PROXY + wallet rate limiting | gateway             | Medium     | open    | `bug` `security` `priority:medium`                 |
| 13  | Payout wallet validation + approval flow    | gateway             | Medium     | open    | `enhancement` `security` `priority:medium`         |
| 14  | Postgres-backed in-app notifications        | notifications       | Medium     | open    | `enhancement` `priority:medium`                    |
| 15  | SQL time-series bucketing                   | gateway             | Medium     | open    | `enhancement` `priority:medium` `good first issue` |
| 16  | SDK unit tests                              | SDK                 | Medium     | open    | `enhancement` `priority:medium` `good first issue` |
| 17  | Receipt route field                         | gateway             | Trivial    | open    | `bug` `trivial` `good first issue`                 |
| 18  | Remove unused Session/ApiKey models         | database            | Trivial    | open    | `enhancement` `trivial` `good first issue`         |

**All 18 issues should carry:** `Stellar Wave` `GrantFox OSS` `Maybe Rewarded`

**Point allocation (open issues):** 2× High (200×2) + 9× Medium (150×9) + 3× Trivial (100×3) = **2,050 total points**

**Implemented/closed:** 4 of 18 issues (DNS rebinding, dashboard tests, email notifications, escrow invariants) are implemented — a strong "active project" signal for grant reviewers.

---

_Prepared for Wave 8 / GrantFox submission — August 2026_
