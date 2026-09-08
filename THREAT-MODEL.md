# THREAT-MODEL.md

> Threat model for the x402 LLM Gateway (Soroban contracts + NestJS gateway +
> Next.js dashboard + TypeScript SDK). Companion to [`SECURITY.md`](./SECURITY.md)
> (policy + residual risks) and [`AUDIT.md`](./AUDIT.md) (findings ledger).
> Last updated: **2026-09-08**.

## 1. Assets

| Asset                                        | Sensitivity                                            | Where it lives                                       |
| -------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| Upstream LLM API keys (`UPSTREAM_API_KEY_*`) | Secret — real money                                    | Gateway env, never exposed to callers                |
| `JWT_SECRET`                                 | Secret — session forgery                               | Gateway env (required, placeholder-rejected at boot) |
| `CONTRACT_ADMIN_SECRET`                      | Secret — on-chain payment recording, escrow settlement | Gateway env / secret manager                         |
| Provider Stellar wallets                     | Financial                                              | On-chain + `Provider.walletAddress` in Postgres      |
| Payment records & receipts                   | Confidential to provider                               | Postgres `Payment`, on-chain `payment-verifier`      |
| Underpayment debt ledger                     | Integrity-critical (revenue)                           | Postgres `UnderpaymentDebt`                          |
| Caller prepaid balances                      | Financial (v2 escrow, opt-in)                          | Soroban `credit-escrow` contract                     |
| Payout proposals                             | Financial                                              | Soroban `multisig` contract                          |
| Audit log                                    | Integrity-critical                                     | Postgres `AuditLog`                                  |

## 2. Trust boundaries

```
                    ┌──────────────────────────────────────────────┐
                    │                  PUBLIC                      │
                    │  Callers (agents, SDK, browsers), attackers  │
                    └───────────────┬──────────────────────────────┘
                                    │ HTTP
                    ┌───────────────▼──────────────────────────────┐
                    │           GATEWAY (NestJS)                   │
                    │  quote → verify → confirm → forward → meter  │
                    │  replay protection · rate limits · SSRF      │
                    └───┬──────────────┬──────────────┬────────────┘
              HTTPS     │              │              │
        ┌───────────────▼───┐   ┌──────▼──────┐  ┌────▼───────────────┐
        │  Horizon / Soroban │   │  PostgreSQL │  │  Redis            │
        │  RPC (public net)  │   │  (payments, │  │  (replay, limits, │
        │                    │   │  routes,    │  │   sessions,       │
        │                    │   │  debts,     │  │   circuits)       │
        │                    │   │  audit)     │  │                   │
        └────────────────────┘   └─────────────┘  └───────────────────┘
                    ┌───────────────▼──────────────────────────────┐
                    │            UPSTREAM LLM (public API)         │
                    └──────────────────────────────────────────────┘
```

- **Callers are untrusted.** Client-supplied payment proofs, headers, and
  bodies are never trusted; every payment is verified against Horizon.
- **Providers (dashboard users) are semi-trusted.** They hold real payment
  addresses and can configure routes; they can also point routes at any
  public upstream (inherent reseller model) and trigger webhooks.
- **Upstream LLM is semi-trusted.** It can return malformed/oversized
  responses or hang; the gateway must fail closed and stay bounded.
- **Blockchain is the source of truth for payments.** The gateway only
  records what Horizon says.

## 3. Threat tables

### 3.1 Payment integrity

| #   | Threat                                                                                           | Impact                                                                                   | Vector                                                             | Mitigation                                                                                                                                                                                                   | Status                            |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| P1  | **Replay of the same tx hash** for repeated LLM access                                           | Free service, revenue loss                                                               | Repeat `X-Payment-Hash` on multiple requests                       | Triple-layer atomic single-use: Redis `SET NX` claim → on-chain `is_payment_used` → Postgres `updateMany({txHash:null})` + unique index. Any layer rejects the second use                                    | ✅ mitigated + tested             |
| P2  | **Concurrent double-spend** of one hash (race)                                                   | Free access via the loser path                                                           | Two parallel requests with the same hash                           | Redis `SET NX` is atomic; DB unique constraint catches cross-instance races; `confirmPayment` returns `null` to losers                                                                                       | ✅ mitigated + race-tested        |
| P3  | **Historical-payment replay** — present an _old_ payment (made before the quote) for free access | One free access per known historical payment to the provider address (public on Horizon) | Old tx hash + fresh quote                                          | New `quote.issuedAt` lower bound: payments dated before quote issuance are rejected (`Payment was made before the quote was issued`)                                                                         | ✅ **fixed 2026-09-08** + tested  |
| P4  | **Payment after quote expiry**                                                                   | Stale-price access                                                                       | Slow payment, expired quote                                        | `txTime > expiresAt` rejected; gateway also refuses expired stored quotes before verification                                                                                                                | ✅ mitigated + tested             |
| P5  | **Underpayment** for per-token routes (deposit < actual cost)                                    | Revenue loss                                                                             | Request with tiny `max_tokens` / deposit, huge response            | Completion capped to deposit estimate; actual cost metered from `usage.total_tokens`; deficit recorded as open debt per (payer, provider); further access gated until a top-up payment clears deposit + debt | ✅ mitigated + e2e-tested         |
| P6  | **Wrong asset / wrong issuer payment** (counterfeit "USDC")                                      | Free access with worthless tokens                                                        | Pay with a fake issuer's token                                     | Verification matches `asset_code` + `asset_issuer` exactly; mainnet boot guard rejects non-Circle `USDC_ISSUER`                                                                                              | ✅ mitigated + tested             |
| P7  | **Path-payment exotic-asset tricks**                                                             | Opaque delivered amounts                                                                 | `path_payment_*` ops                                               | Mainnet: only direct `payment` ops accepted (`allowPathPayments=false`); path ops rejected with explicit reason                                                                                              | ✅ mitigated + tested             |
| P8  | **Quote front-running / griefing** — third party pays a victim's quote first                     | Victim must re-quote; attacker loses funds                                               | Monitor 402 quotes, pay the address                                | Memo is attribution-only by design; attacker pays real funds and gets nothing; single-use guards keep the victim safe. Documented residual                                                                   | ⚠️ accepted (griefing, not theft) |
| P9  | **Old payment used across quotes after Redis TTL expiry**                                        | Free access                                                                              | Wait for Redis claim TTL (1h) to expire, reuse hash on a new quote | On-chain `USED_TX` replay guard is permanent; DB single-use row is permanent                                                                                                                                 | ✅ mitigated                      |
| P10 | **Debt-gate bypass** via provider hopping                                                        | Debt never collected                                                                     | Payer with debt on provider A uses provider B                      | Debt is per (payer, provider) by design — cross-provider debt is out of scope; documented                                                                                                                    | ⚠️ accepted (documented)          |
| P11 | **Escrow double-charge / double-refund**                                                         | User funds stolen                                                                        | Replay `charge`/`refund` calls                                     | Per-(user, quote_id) idempotency guards in `credit-escrow`; tested                                                                                                                                           | ✅ mitigated (opt-in v2)          |

### 3.2 Gateway & infrastructure

| #   | Threat                              | Impact                                        | Vector                                                       | Mitigation                                                                                                                                                                                                                       | Status                              |
| --- | ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| G1  | **SSRF via upstream/webhook URLs**  | Reach cloud metadata / internal services      | Configure `https://169.254.169.254/…` or DNS-rebind a domain | Config-time DNS resolution + public-IP-only validation (private/loopback/link-local/CGNAT/metadata rejected); webhook URLs HTTPS-only; DNS **re-validated at proxy time** with 60s cache against rebinding                       | ✅ mitigated + tested               |
| G2  | **Upstream DNS rebinding (TOCTOU)** | Cloud metadata access                         | Provider controls domain, rebinds after config               | `isUpstreamHostPublic()` re-resolves at every forward; both streaming and non-streaming paths                                                                                                                                    | ✅ mitigated + tested               |
| G3  | **Rate-limit bypass**               | Quote-spam / Horizon abuse / CPU burn         | Rotate IPs, spoof `X-Forwarded-For`                          | IP-based sliding window (Redis Lua); `trust proxy` configurable; spoofing only possible if directly exposed without a proxy (documented); paid tier requires a _confirmed_ payment row (header spoofing doesn't raise the limit) | ⚠️ residual (IP-only) — documented  |
| G4  | **Memory DoS via request body**     | OOM                                           | Huge chat payloads                                           | Express body limit 1 MB + zod bounds: ≤128 messages, ≤64 KiB content, `max_tokens` ≤ 1,000,000                                                                                                                                   | ✅ **fixed 2026-09-08** + tested    |
| G5  | **Slowloris / hung Horizon**        | Worker exhaustion                             | Slow RPC/Horizon                                             | Per-request `AbortSignal.timeout` on every Horizon/Soroban RPC fetch (`HORIZON_TIMEOUT_MS`/`SOROBAN_RPC_TIMEOUT_MS`, default 10 s); server `requestTimeout`/`headersTimeout` caps                                                | ✅ **fixed 2026-09-08** + tested    |
| G6  | **Streaming memory blowup**         | OOM                                           | Slow consumer + fast upstream                                | Backpressure: `res.write() === false` → await `drain`/`close` before reading more                                                                                                                                                | ✅ **fixed 2026-09-08**             |
| G7  | **Circuit-breaker thrash**          | Upstream cascades                             | One failing upstream trips all                               | Per-hostname circuit breaker (Redis-shared or in-memory), 5 failures → open 30 s, half-open probe                                                                                                                                | ✅ implemented + tested             |
| G8  | **JWT forgery**                     | Dashboard takeover                            | Weak/default secret                                          | `JWT_SECRET` required + placeholder-rejected at boot; HS256 with issuer; sessions also validated in Redis                                                                                                                        | ✅ mitigated + tested               |
| G9  | **Auth challenge replay**           | Session hijack                                | Reuse a signed challenge                                     | Challenge single-use (deleted on verify), 5 min TTL, address-scoped                                                                                                                                                              | ✅ mitigated + tested               |
| G10 | **XSS → session theft**             | Dashboard takeover                            | Stored XSS in dashboard                                      | httpOnly session cookie (JS-inaccessible); SameSite Lax/None documented; CSP via helmet on gateway                                                                                                                               | ✅ mitigated                        |
| G11 | **Cross-tenant data access**        | Provider A reads provider B's payments/routes | Guess IDs, probe endpoints                                   | Every query scoped by authenticated `walletAddress`; 404 vs 403 anti-probing choices documented; provider stats 404 on foreign IDs                                                                                               | ✅ mitigated + tested               |
| G12 | **Admin-key XLM exhaustion**        | On-chain audit trail silently stops           | High request volume                                          | Best-effort recording with failure logs; **new** `x402_onchain_record_failures_total` metric + documented alert; budget XLM reserve                                                                                              | ⚠️ documented (alert now available) |
| G13 | **Secret leakage**                  | Full compromise                               | Secrets committed                                            | `.gitignore` covers `.env`; gitleaks scans full history in CI; `maskSensitive` logging; secrets never in responses                                                                                                               | ✅ mitigated (CI now scans)         |
| G14 | **Malformed upstream responses**    | 502 storms / crashes                          | Upstream bug                                                 | 4xx → NonRetryable, 5xx → bounded retries; parse failures return 502                                                                                                                                                             | ✅ mitigated                        |

### 3.3 Smart contracts

| #   | Threat                                                             | Impact                                            | Vector                            | Mitigation                                                                                                                                    | Status                        |
| --- | ------------------------------------------------------------------ | ------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| C1  | **Unauthorized `record_payment` / `refund` / `set_admin` / pause** | Fake audit trail, refund abuse                    | Unsigned calls                    | `config.admin.require_auth()` on every mutator; tested                                                                                        | ✅ mitigated                  |
| C2  | **Re-init takeover** (`init` called twice)                         | Contract drained / rewritten                      | Second `init` with attacker admin | `init` panics if CONFIG exists; tested on all three contracts                                                                                 | ✅ mitigated                  |
| C3  | **Multisig single-signer takeover / drain**                        | Wallet drained                                    | Rotate signers with 1 key         | `set_signers` requires current-threshold distinct approvers, each `require_auth`'d; duplicate approvers count once; tested incl. 2-of-3 cases | ✅ mitigated                  |
| C4  | **Multisig duplicate-signer set**                                  | One key dominates                                 | `init`/`set_signers` with dupes   | `has_unique_signers` rejects; tested                                                                                                          | ✅ mitigated                  |
| C5  | **Escrow balance underflow / over-withdraw**                       | User funds stolen                                 | Arithmetic on balances            | `current < amount` panics on `withdraw`/`charge`/`refund`; positive-amount checks everywhere                                                  | ✅ mitigated                  |
| C6  | **Double-charge / double-refund of a quote**                       | User funds stolen                                 | Replayed settlement               | Per-(user, quote_id) `CHARGED`/`REFUNDED` guards; tested                                                                                      | ✅ mitigated                  |
| C7  | **Gas-DoS via unbounded reads**                                    | Contract unusable                                 | `get_payments(0, u32::MAX)`       | `limit` clamped to `MAX_PAGE_SIZE` (100); `saturating_add` prevents overflow; tested                                                          | ✅ mitigated                  |
| C8  | **TTL/rent abuse**                                                 | Contract archived, or reads keep it alive forever | Spam reads                        | Mutators extend instance + per-entry TTLs to `LEDGERS_TO_LIVE`; reads never extend TTL; tested                                                | ✅ mitigated                  |
| C9  | **Zero/negative amounts recorded**                                 | Corrupt audit trail                               | Malformed args                    | `amount <= 0` panics; tested                                                                                                                  | ✅ mitigated                  |
| C10 | **Revenue/refund accounting drift**                                | Admin withdraws wrong amounts                     | charge/refund sequences           | Revenue scalar tracks charged-only funds; invariant tests cover deposit→charge→refund→withdraw paths                                          | ✅ mitigated (contract tests) |

### 3.4 Dependencies & supply chain

| #   | Threat                            | Impact                   | Vector           | Mitigation                                                                                                                                                                                                                                                                                           | Status                                                   |
| --- | --------------------------------- | ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| S1  | **Known vulnerable dependencies** | Varies (ReDoS, DoS, RCE) | Transitive deps  | `pnpm audit` gate at **critical** in CI; NestJS 11.2.3/Express 5.2.1 + Next 15.5.25/React 19 upgrade resolved the last runtime-reachable advisories (**0 critical, 0 runtime-reachable**, 9 total — dev-tooling only); trivy fs scan + osv-scanner report all severities; SBOM generated per release | ✅ 2026-09-08; remaining are dev-tooling tracks (see §4) |
| S2  | **Malicious install scripts**     | Supply-chain RCE         | pnpm postinstall | `allowBuilds` whitelist in `pnpm-workspace.yaml` — only prisma/esbuild/nx/@nestjs-core/@parcel-watcher may run scripts                                                                                                                                                                               | ✅ hardened                                              |
| S3  | **Lockfile tampering**            | —                        | —                | Lockfile committed + `--frozen-lockfile` in all CI installs                                                                                                                                                                                                                                          | ✅                                                       |

## 4. Residual risks (accepted, documented)

1. **Contracts are self-tested, not externally audited.** No third-party audit
   has reviewed the three Soroban contracts. This is the #1 mainnet gate
   (`MAINNET_READINESS.md` §1).
2. **Rate limiting is IP-only.** Behind a trusted proxy this is sound; a
   directly-exposed gateway without `TRUST_PROXY=0` can be bypassed by
   spoofing `X-Forwarded-For`.
3. **Quote front-running is griefing-only** (P8): a third party can pay
   someone's quote first, costing the attacker real funds; the victim
   re-quotes. Memo enforcement is deliberately off.
4. **Cross-provider debt hopping** (P10): a payer with debt on provider A can
   use provider B. Per-provider trust model.
5. **Dev/build-tooling advisories remain** (`nx` 19, `webpack-dev-server` 4,
   `image-size` — no patched release exists). Build-time only, no
   runtime-reachable path; tracked in `MAINNET_READINESS.md` §7.
6. **Soroban gas/storage benchmarks are executed and gated in CI.**
   `src/bench.rs` in each contract measures fee/entry costs at growing
   history sizes and asserts the O(1) invariant (see
   [`GAS-OPTIMIZATION.md`](./GAS-OPTIMIZATION.md) §5.5 for the 2026-09-08
   results ledger: fee flat 1.004×–1.009×, entries byte-identical); CI also
   gates contract WASM size (< 64 KiB).
7. **Restore-from-archive semantics**: persistent entries not written for
   `LEDGERS_TO_LIVE` ledgers require a paid archive restore to read
   (audit-trail durability tradeoff).
8. **Escrow settlement is opt-in/experimental** — fire-and-forget, not
   enforced without the account model.

## 5. Assumptions

- The gateway operator runs TLS-terminating infrastructure (Cloudflare/NGINX
  recommended) and does not expose the gateway directly on the public
  internet without a proxy.
- `TRUST_PROXY` is set correctly for the deployment topology.
- Horizon/Soroban RPC endpoints are operated by SDF or a reputable provider;
  the gateway fails **closed** when they error (valid payments are never
  falsely accepted).
- Redis runs with AOF persistence in production (replay-guard durability
  across restarts).

## 6. Verification & fuzzing posture

- Payment invariants are covered by deterministic property-based tests
  (`packages/x402-core/src/amount-property.spec.ts`, seeded PRNG): stroop
  round-trips, quote clamping, price arithmetic identities — 500 iterations
  per property.
- Concurrency: Redis `SET NX` claim race and in-memory claim races tested.
- Negative tests: wrong asset, wrong recipient, expired quote, pre-issued
  payment, malformed amounts, non-numeric prices, oversize payloads.
- Contracts: hand-written edge-case suites (see §3.3); cargo-fuzz/proptest
  integration and an external audit are tracked as mainnet gates.
