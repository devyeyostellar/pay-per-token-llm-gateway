# ARCHITECTURE.md

> System architecture for the x402 LLM Gateway — Soroban contracts, NestJS
> gateway, Next.js dashboard, TypeScript SDK, and shared packages.
> Last updated: **2026-09-08**.

## 1. System overview

The gateway is a pay-per-request reverse proxy for LLM APIs. Clients pay USDC
on Stellar (via a standard payment transaction to a provider's address), then
retry their request with the transaction hash. The gateway verifies the
payment on-chain, atomically consumes the hash (single-use), forwards the
request to the upstream LLM, and meters per-token cost afterwards.

```
                402 + quote                pay USDC on Stellar
   Caller  ◄────────────────────┐   ┌──────────────────────────────►  Horizon
   (SDK/agent)                  │   │                                   │
     │  POST /chat/completions ─┘   │                                   │
     │  + X-Payment-Hash ───────────┼──────────────────────────────►   │
     │                              │  verify tx + ops                 │
     │  ◄── LLM response ───────────┼────────────────────────────────   │
     │                              │                                   │
     │                              │  Soroban payment-verifier         │
     │                              │  (replay guard + audit trail)     │
```

## 2. Monorepo layout

```
apps/gateway        NestJS proxy: quote → verify → confirm → forward → meter
apps/dashboard      Next.js provider dashboard (routes, payments, analytics)
contracts/          Soroban contracts: payment-verifier, credit-escrow, multisig
packages/types      Shared TypeScript types (Quote, RouteConfig, Payment…)
packages/x402-core  Protocol core: generateQuote, verifyStellarPayment, ReplayProtection, price math
packages/sdk        Client SDK (402 → pay → retry; streaming)
packages/config     Env validation + fail-fast guards (JWT, mainnet consistency)
packages/validation Zod schemas for every I/O boundary
packages/database   Prisma client, schema, migrations
packages/logger     Structured logs (text + JSON)
packages/wallet     Stellar tx building, keypair, Horizon helpers, challenge signing
packages/authentication  Challenge-response auth + Redis sessions
packages/analytics  Usage/revenue analytics service
packages/notifications   Webhook/in-app notification dispatch
packages/shared     generateId, amount conversion, retry, RedisLike, IP checks
infrastructure/docker   Dockerfiles + compose (dev, mainnet)
.github/workflows  CI (lint/test/build/security), Deploy (docker + contracts + SBOM)
```

## 3. Gateway request flow (the money path)

All three security-critical steps — quote, verify, confirm — run in
`apps/gateway/src/modules/proxy/proxy.controller.ts`:

1. **Validate** — zod `chatCompletionRequestSchema` (≤128 messages, ≤64 KiB
   content, ≤1M `max_tokens`, 1 MB body cap).
2. **Resolve route** — `RoutesService.findByPathAndModel` (path normalization
   - model match, active routes only).
3. **No payment → 402** — `X402Service.generateQuoteForRoute`:
   - flat → `amount = flatPrice`; per_token → `amount = perTokenPrice ×
estimate` (from `max_tokens` or `DEFAULT_TOKEN_ESTIMATE` = 4096).
   - clamped to `MIN_PAYMENT_AMOUNT`; carries `issuedAt`/`expiresAt`
     (window = `QUOTE_EXPIRY_SECONDS`, default 300 s).
   - a `Payment` row is created (`pending`) and an audit log entry written.
4. **Payment header present → verify** (`X402Service.verifyPayment`):
   - **L1 Redis**: `ReplayProtection.claim` — atomic `SET NX` (`x402:replay:*`,
     TTL `PAYMENT_CACHE_TTL`).
   - **L1b on-chain**: `isPaymentUsedOnChain` — `getLedgerEntries` on
     `USED_TX` (permanent, survives Redis loss).
   - **L2 Horizon**: `verifyStellarPayment` — tx successful, payment op
     matches asset+issuer+destination, amount satisfies pricing model
     (flat: exact; per_token: ≥ deposit), and the payment timestamp falls
     **inside** `[issuedAt, expiresAt]`. All fetches bounded by
     `HORIZON_TIMEOUT_MS` (default 10 s).
   - On success, best-effort `recordPaymentOnChain` (audit trail +
     permanent replay guard) signed by `CONTRACT_ADMIN_SECRET`.
5. **Debt gate** — outstanding `UnderpaymentDebt` for (payer, provider)?
   Payment must cover deposit + debt; surplus clears the ledger; otherwise a
   402 top-up quote (deposit + debt) is returned and the hash stays consumed.
6. **Confirm (atomic single-use)** — `PaymentsService.confirmPayment`:
   `updateMany({ where: { quoteId, txHash: null } })` + unique index on
   `Payment.txHash`. Losers of the race get `null` → 402 replay rejection.
7. **Forward** — `ProxyService.forwardRequest`/`forwardStreamRequest`:
   DNS-rebind re-validation, circuit breaker, retries (4xx non-retryable,
   5xx bounded), `AbortSignal.timeout` per attempt; streaming honors
   backpressure and propagates client disconnect to the upstream.
8. **Meter** — `applyMeteredPricing`: per-token actual cost from
   `usage.total_tokens`; surplus/underpayment headers; underpayment →
   `recordUnderpaymentDebt` (unique per quote); opt-in escrow settlement
   (`settleEscrow`, fire-and-forget).

## 4. Replay protection — the three layers

| Layer                      | Mechanism                                  | Scope                         | Failure mode                               |
| -------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------------------ |
| Redis                      | `SET NX` claim, TTL 1 h                    | Per deployment (shared Redis) | Lost on Redis wipe → next layer holds      |
| Soroban `payment-verifier` | `USED_TX` persistent entry, permanent      | Cross-instance, immutable     | RPC down → logged, falls back (documented) |
| Postgres                   | `updateMany({txHash:null})` + unique index | Per DB                        | —                                          |

Atomicity: the Redis claim is the fast path; the DB claim is the final
authorization; the on-chain record is the durable audit. Any one of them
rejecting is sufficient to refuse access.

## 5. Storage

### 5.1 PostgreSQL (Prisma)

- `Provider` (merchant + receiving wallet), `Route` (upstream URL, pricing),
  `Payment` (quote→hash lifecycle, single-use), `UnderpaymentDebt` (per-token
  deficits), `PrepaidCredit` (v2), `Notification`, `AnalyticsEvent`,
  `AuditLog`. Multi-tenant isolation: every provider-scoped query filters on
  the authenticated wallet's `walletAddress`.

### 5.2 Redis

- `x402:replay:*` payment claims · `x402:ratelimit:<tier>:<ip>` sliding
  windows · `x402:auth:*` challenges/sessions · `x402:circuit:*` breaker
  state. AOF recommended for replay-guard durability.

### 5.3 Soroban contracts (persistent-storage layout)

| Contract           | Instance (fixed-size)                              | Persistent (per-key)                                                                               |
| ------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `payment-verifier` | CONFIG (admin, paused), PAY_CNT counter            | `(USED_TX, hash)`, `(PAYMENT, idx)`, `(TX_IDX, hash)`                                              |
| `credit-escrow`    | CONFIG (admin, asset, paused), REVENUE             | `(BALANCES, user)`, `(USAGE, user, idx)`, `(USAGE_COUNT, user)`, `(CHARGED/REFUNDED, user, quote)` |
| `multisig`         | CONFIG (signers, threshold, token), PROPOSAL_COUNT | `(PROPOSALS, id)`                                                                                  |

Per-entry storage keeps every read/write O(1) regardless of history size;
mutators extend instance + per-entry TTLs to `LEDGERS_TO_LIVE`, reads never
extend TTL (see `GAS-OPTIMIZATION.md`).

## 6. Authentication (dashboard)

1. `POST /api/v1/auth/challenge` → nonce, 5 min TTL, single-use.
2. Client signs the challenge with their Stellar keypair; `POST
/api/v1/auth/verify` verifies the Ed25519 signature, creates a Redis
   session, and returns a JWT (HS256, `x402-gateway` issuer).
3. Session token lives in an **httpOnly** cookie (`x402-session`; `Secure` in
   production); an Authorization-header fallback exists for pre-cookie
   clients and migrates them to the cookie.
4. `AuthGuard` validates JWT + Redis session on every protected route.
5. `AUTH_DEV_MODE=true` (dev-only signature bypass) is refused at boot when
   `NODE_ENV=production`.

## 7. Observability

- **Logs**: `@x402/logger` — structured JSON in production (`enableJsonLogs`),
  trace IDs on every proxy request (`X-Request-Trace-Id`).
- **Metrics**: Prometheus at `GET /metrics` (outside the `api/v1` prefix):
  default Node metrics + `http_requests_total`,
  `http_request_duration_ms`, `x402_quotes_generated_total`,
  `x402_payments_verified_total`, `x402_payment_verification_failed_total`,
  `x402_upstream_failures_total`, `x402_upstream_retries_total`,
  `x402_circuit_breaker_opens_total`, `x402_underpayment_debts_recorded_total`,
  `x402_onchain_record_failures_total`. See [`OBSERVABILITY.md`](./OBSERVABILITY.md).
- **Health**: `/health` + `/health/live` (liveness) and `/health/ready`
  (Postgres + Redis checks, 503 with per-dependency detail).

## 8. Deployment topology

```
Cloudflare/NGINX (TLS, trusted proxy)
        │
   Gateway (NestJS, 1..N replicas) ── Postgres ── Redis (AOF)
        │                                   │
   Horizon / Soroban RPC              Dashboard (Vercel/Next.js)
        │
   Upstream LLM APIs (per provider)
```

- Docker images are non-root, healthchecked, with provenance labels.
- CI: lint → test (coverage-gated) → e2e → contracts (`cargo test`) →
  build → security scans (audit/gitleaks/trivy/osv-scanner).
- Deploy (tag `v*`): gated on green CI, pushes images, deploys Soroban
  contracts to testnet with `init` + address persistence, and attaches a
  CycloneDX SBOM to the release.

## 9. Data flows of note

- **Flat rate**: one payment = one request, exact amount, no metering.
- **Per-token**: deposit (estimate) → capped completion → metered actual cost
  → surplus/underpayment reconciliation → debt ledger.
- **Debt top-up**: refused payer receives a 402 with amount = deposit + open
  debt; the SDK pays one transaction covering both; verification requires ≥
  that combined amount and clears the ledger.
- **Webhooks**: `payment_received` / `verification_failed` /
  `request_forwarded` delivered with HMAC-SHA256 signature
  (`X-x402-Signature`) and SSRF re-validation at delivery time.
