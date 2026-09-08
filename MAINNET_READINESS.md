# MAINNET_READINESS.md

> **Status: TESTNET ONLY — not mainnet-ready.** This document is the honest
> go/no-go gate for a Stellar mainnet launch of the x402 LLM Gateway. It is
> deliberately narrower than the generic _Production Checklist_ in the
> README (TLS, Redis AOF, RPC API keys, …) — that checklist is about running
> _any_ service well; this one is about the Stellar/chain-specific risks that
> determine whether real USDC can flow through the system safely.
>
> Last updated: **2026-09-08** (post audit-and-hardening pass) · Applies to
> commit `bf2bdd8` + the 2026-09-08 hardening commit.

---

## 1. Audit status| Item | Status |

| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Third-party smart-contract audit | **Not completed.** No external audit firm has reviewed the Soroban contracts or the gateway. |
| Self-audit | `AUDIT.md` (2026-08-11) + a fresh audit-and-hardening pass on **2026-09-08**: quote-window integrity (`issuedAt`), Horizon/Soroban fetch timeouts, request-size bounds, readiness endpoints, Prometheus metrics, dependency overrides (0 critical), CI secret/container/lockfile scans, non-root Docker images, streaming backpressure. |
| Test coverage (contracts) | payment-verifier **23** · credit-escrow **43** · multisig **32** unit tests under `cargo test`. Hand-written edge cases only — no property/fuzz/invariant suite, no external review, no executed gas benchmark (methodology in `GAS-OPTIMIZATION.md`). |
| Test coverage (gateway) | Unit suites green with coverage gates (gateway 127 unit + 34 e2e; x402-core 66 incl. deterministic property-based tests; validation 25; sdk 15). |
| Disclosure policy | `SECURITY.md` now lists concrete residual risks (§"Known Residual Risks") and the CI scanning pipeline. |

**Go/no-go implication:** a mainnet launch with real USDC before an
independent audit of the three contracts is a _trust decision_, not a
technical one. If the grant/audit review this repo is being prepared for
requires it, an external audit of the Soroban contracts is the single largest
unfinished item. Until then, treat the contracts as **self-tested,
unaudited** in every external communication.

---

## 2. USDC issuer & trustline risk on mainnet

### 2.1 The gateway enforces the configured issuer — so configuration is the risk

Payment verification (`packages/x402-core`) only accepts a payment operation
whose asset matches the quote **and** whose issuer matches
`quote.assetIssuer`, which is derived from `USDC_ISSUER` at quote time. A
mainnet gateway pointed at the wrong issuer would happily accept that
issuer's "USDC" — which could be a worthless or malicious token.

- Testnet default issuer: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Mainnet must use Circle's issuer:** `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (already set in `.env.mainnet.example`)

**Go/no-go actions:**

- [ ] Before launch, verify the quote asset issuer end-to-end on mainnet:
      submit a payment from a _wrong-issuer_ fake USDC and confirm the
      gateway returns 402 (never forwards).
- [ ] Pin `USDC_ISSUER` per environment and make the value an explicit,
      reviewed deploy artifact (CI secret), not something set ad hoc.
- [ ] Consider rejecting `path_payment_*` operations entirely (see §3) so
      the only accepted asset path is a direct `payment` of Circle USDC.

### 2.2 Trustlines on gateway-held accounts

- The gateway's receiving/payout Stellar accounts must hold a **USDC
  trustline** to Circle's issuer on mainnet before they can receive USDC in a
  classic `payment` op. Add trustline setup to the launch runbook (testnet
  accounts typically already carry one; mainnet accounts do not by default).
- The **credit-escrow contract** receives and holds USDC on behalf of users.
  The contract instance must be funded and the escrow's token must be the
  SAC of mainnet Circle USDC. Escrow settlement is currently **opt-in and
  experimental** (`ESCROW_SETTLEMENT_ENABLED`, §6) — do not enable it for
  mainnet v1 until the account-based model is a deliberate product decision
  (see §6, open issue #25).

### 2.3 Multi-issuer / asset drift

Mainnet USDC is a classic asset issued by Circle. If Circle ever migrates
issuers, the gateway has a single hardcoded `USDC_ISSUER` — there is no
multi-issuer allowlist. Treat issuer migration as a config change requiring a
coordinated cutover, not something the system adapts to automatically.

---

## 3. Fees & slippage under real network conditions

### 3.1 Who pays what

| Cost                                | Paid by                                     | Notes                                                                                                                                                                                        |
| ----------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client payment (USDC transfer)      | Client                                      | Standard Stellar network fee (base fee in XLM). Under congestion the client may need a higher fee; the gateway should not require exact fee values — only the delivered USDC amount matters. |
| `record_payment` (payment-verifier) | Gateway admin key (`CONTRACT_ADMIN_SECRET`) | A Soroban invoke per verified payment. Fee = base fee + resource (CPU/memory/ledger) fees.                                                                                                   |
| Escrow `deposit`/`charge`/`refund`  | Client / gateway                            | Only when escrow settlement is enabled (§6). Client pays deposit submission; gateway pays `charge`/`refund` invokes.                                                                         |
| Multisig payouts                    | Gateway admin / signers                     | Fee per `propose`/`approve` invoke.                                                                                                                                                          |

**Implication:** the gateway admin key must hold enough XLM to cover
Soroban resource fees for the expected request volume. Underestimating this
is a _silent availability_ failure mode: once the admin key runs out of XLM,
`record_payment` calls fail (fire-and-forget today), and the on-chain audit
trail silently stops while the gateway keeps serving requests. Budget XLM
reserves and alert on admin-key balance.

### 3.2 Slippage

- A direct USDC `payment` op has **no slippage**: the delivered amount is
  exact.
- The verifier **also accepts `path_payment_strict_send` and
  `path_payment_strict_receive` ops** and matches on the _delivered_
  destination amount. This is how a client without a direct USDC trustline
  could still pay (e.g., route XLM → USDC). Slippage on the source side is
  the client's problem; the gateway only credits what actually arrives.
  - Flat-rate quotes require an **exact** delivered-amount match — a path
    payment that lands a fraction of a stroop short is rejected.
  - Per-token quotes require the delivered amount to **cover the deposit**
    (≥), so mild under-delivery below the deposit is rejected and the
    underpayment policy (§6) then governs.
- **Recommendation:** for mainnet v1, restrict accepted ops to direct
  `payment` only. Path payments widen the attack surface for exotic-asset
  tricks and add no value when the goal is permissionless USDC access.

### 3.3 Fee spikes and minimums

- Quotes and verification are in stroops; `MIN_PAYMENT_AMOUNT` (default
  0.001 USDC) guards degenerate zero-price routes.
- Soroban resource fees can spike with ledger congestion. Contract-call
  failures must be **observable** (alerting on `record_payment`/settlement
  failure rates) even though they are currently best-effort.

---

## 4. Network & replay risk (mainnet configuration)

- Stellar signatures are scoped to the network passphrase, so a testnet
  transaction **cannot** be replayed on mainnet — cross-network replay is not
  possible at the protocol level.
- The realistic risk is **configuration drift**: a "mainnet" gateway whose
  `HORIZON_URL` / `SOROBAN_RPC_URL` / `NETWORK_PASSPHRASE` actually point at
  testnet would verify worthless testnet payments and serve real LLM compute
  for them.
- **Runtime guard: implemented.** `packages/config` runs a boot-time
  `assertMainnetNetworkConsistency()` check (in both `validateEnv()` and
  `loadConfig()`). With `STELLAR_NETWORK=mainnet` it fails fast when Horizon
  or Soroban RPC points at a test/future endpoint, when `NETWORK_PASSPHRASE`
  is not the mainnet passphrase (`Public Global Stellar Network ; September
2015`), or when `USDC_ISSUER` is not Circle's mainnet issuer.
  Provider-specific mainnet Horizon/RPC endpoints remain allowed (only the
  test/future markers and the foreign passphrase/issuer are rejected).

---

## 5. Application-layer trust items that gate mainnet

These come from the self-audit and the Phase 2 hardening work; each is either
done or an explicit decision point:

| Item                                                                                           | Status                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_DEV_MODE=true` + `NODE_ENV=production` boot refusal                                      | ✅ Done (`packages/config` guard + tests). The old any-wallet `dev-sig-` bypass can no longer reach production.                                                                                                                                                                                                                             |
| Per-token underpayment enforcement (deposit + outstanding-debt top-up gate, completion cap)    | ✅ Done. New `UnderpaymentDebt` Prisma model — **requires `pnpm db:push`** (repo has no migration files) before the debt-gate queries run against a real DB.                                                                                                                                                                                |
| Soroban contracts migrated to **persistent storage** (per-entry ledger entries, per-entry TTL) | ✅ Done, commit `c769a99`. **This changed the storage layout — mainnet MUST deploy the new WASM.** There is no mainnet state, so this is a clean redeploy, not a migration.                                                                                                                                                                 |
| Per-entry TTL policy                                                                           | ⚠️ Deliberate tradeoff: an untouched record needs a paid restore-from-archive read after `LEDGERS_TO_LIVE` ledgers. Fine for an audit trail; document for operators.                                                                                                                                                                        |
| Credit-escrow settlement                                                                       | ⚠️ Opt-in, **experimental**, fire-and-forget (no enforcement without the account model). Keep disabled for mainnet v1 or make it a product decision (open issue #25).                                                                                                                                                                       |
| Email notifications (SMTP)                                                                     | ✅ Removed — the handler was never registered, its SMTP config was inert, and no recipient model existed. `EmailNotificationHandler`, the `EMAIL_*`/`SMTP_*` config, and the nodemailer dependency were deleted. Re-add with a proper per-recipient model if email is ever wanted.                                                          |
| Rate limiting                                                                                  | IP-only today (self-audit M7). The README/SECURITY claim of "by IP or wallet" overstates it. Acceptable for v1 with documented limits, or add wallet-based limiting.                                                                                                                                                                        |
| External audit                                                                                 | ❌ Not done (see §1).                                                                                                                                                                                                                                                                                                                       |
| Payment verification window (historical-hash reuse)                                            | ✅ **Fixed 2026-09-08** — quotes now carry `issuedAt`; payments dated before issuance are rejected (lower-bound window), closing the "old payment + fresh quote = one free access" gap. Tested.                                                                                                                                             |
| Timeouts on Horizon/Soroban fetches                                                            | ✅ **Fixed 2026-09-08** — `HORIZON_TIMEOUT_MS` / `SOROBAN_RPC_TIMEOUT_MS` (default 10 s) via `AbortSignal.timeout`; server `requestTimeout`/`headersTimeout` caps. Tested.                                                                                                                                                                  |
| Request-size / memory bounds                                                                   | ✅ **Fixed 2026-09-08** — ≤128 messages, ≤64 KiB content, `max_tokens` ≤ 1M (zod) on top of the 1 MB body cap; streaming honors backpressure. Tested.                                                                                                                                                                                       |
| Dependency posture (supply chain)                                                              | ✅ **Improved 2026-09-08** — **0 critical** advisories; reachable runtime advisories in the gateway tree fixed via overrides (express, ws, body-parser, qs, uuid, lodash, js-yaml, toml, postcss, file-type). Remaining highs = major-version tracks (§7). CI: gitleaks + trivy + osv-scanner + SBOM per release; install-script allowlist. |

---

## 6. Go / No-Go checklist

**No-go unless every box in this section is checked.** This is the launch
gate, distinct from the README's generic production checklist.

### A. Chain & contracts

- [ ] External audit of the three Soroban contracts completed (or an
      explicit, recorded decision to launch unaudited).
- [ ] Contracts deployed to mainnet **from the current WASM** (post
      persistent-storage migration) via
      `STELLAR_NETWORK=mainnet STELLAR_SECRET_KEY=S... bash scripts/deploy-contracts.sh`;
      addresses recorded in `contracts/deployed-addresses.json` under
      `mainnet` and mirrored into env config.
- [ ] Escrow contract either not deployed / not wired, or its account-based
      model accepted as a product decision.
- [ ] Admin key custody: `CONTRACT_ADMIN_SECRET` in a secret manager, never
      in git/env files; XLM reserve funded; balance alerting configured.

### B. Network configuration

- [x] `STELLAR_NETWORK=mainnet`, mainnet `HORIZON_URL`/`SOROBAN_RPC_URL`,
      mainnet passphrase, Circle `USDC_ISSUER` — enforced at boot by
      `assertMainnetNetworkConsistency()` in `packages/config` (§4).
- [ ] Receiving/payout accounts hold Circle USDC trustlines.
- [ ] Wrong-issuer and wrong-network payments verified to be rejected in a
      staging rehearsal before launch.

### C. Gateway & data

- [ ] `pnpm db:push` applied so the `UnderpaymentDebt` table exists; schema
      diff reviewed.
- [ ] `AUTH_DEV_MODE` unset/false in the mainnet environment (boot guard
      enforced).
- [ ] Email-notification decision made (wired, or SMTP config removed).
- [ ] Redis persistence (AOF) enabled — replay protection durability.
- [ ] Monitoring: payment-verification failure rate, contract-call failure
      rate, admin-key XLM balance, upstream LLM error rate, debt-gate denials.

### D. Product & risk posture

- [ ] Honest audit-status line published in the README (no "audited" badge).
- [ ] Known residual risks documented in `SECURITY.md` (IP-only rate
      limiting, unaudited contracts, per-entry TTL/restore semantics,
      escrow experimental).
- [ ] Provider payout flow decided: multisig contract or manual/off-chain.

---

## 7. Dependency upgrade tracks (remaining advisories)

**Completed 2026-09-08** — the three previously tracked runtime residuals are
resolved by major-version upgrades (verified: gateway unit + e2e suites and
dashboard build all green on the new stacks):

| Package                           | Before                    | After                                           | Notes                                                                              |
| --------------------------------- | ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `next` (dashboard)                | 14.2 (high, <15.5.21)     | **15.5.25** + React 19 / recharts 2.15          | dashboard has no auth middleware, so the middleware-bypass class never applied     |
| `@nestjs/core` / platform-express | 10.3 (moderate, <11.1.18) | **11.2.3** on Express 5.2.1                     | Express 5: no wildcard routes or `req.query` mutation in gateway → clean migration |
| `multer` (via platform-express)   | 1.4.x (high, <2.2.0)      | **2.2.0** (pinned by platform-express 11.1.28+) | gateway exposes no file-upload endpoints; ESM/CJS constraint lifted by NestJS 11   |

**Remaining (2026-09-08)** — all dev/build-tooling only, never shipped to
runtime, no runtime-reachable path:

| Package              | Severity | Why not fixed                                                                                                            | Track                                      |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `nx` 19.5.7          | moderate | fix requires nx ≥22.7.2 (major); pinned with webpack-dev-server 4.x via `@nx/webpack`                                    | nx 22 migration before next toolchain bump |
| `webpack-dev-server` | moderate | 4.15.2 pinned by `@nx/webpack@19`; fix needs 5.x (major) which `@nx/webpack` 19 does not support                         | resolved by the nx 22 track                |
| `image-size`         | high     | **no patched version exists** (patched: null); dev-only transitive of `less@4.1.3` (CSS compilation in nx webpack chain) | drop `less`/nx-webpack when migrating      |

## 8. References

- `README.md` — Production Checklist (generic infra) and Trust Model
- `AUDIT.md` — automated self-audit findings (2026-08-11)
- `SECURITY.md` — disclosure policy (needs residual-risk update)
- `.env.mainnet.example` — mainnet environment template (Circle USDC issuer
  already set)
- `scripts/deploy-contracts.sh` — network-aware deploy + address persistence
- `DEPLOYMENT.md` — full deployment walkthrough (+ testnet verification journey)
- `GAS-OPTIMIZATION.md` — storage/gas design + benchmarking methodology
- `THREAT-MODEL.md` / `OPERATIONS.md` / `OBSERVABILITY.md` — threats, DR/RTO-RPO, dashboards
