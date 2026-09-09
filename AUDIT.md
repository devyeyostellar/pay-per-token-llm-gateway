# 🔍 Engineering Audit Report — x402 LLM Gateway

**Audited:** `mallonepay/pay-per-token-llm-gateway` — Soroban contracts
(`payment-verifier`, `credit-escrow`, `multisig`), NestJS gateway, Next.js
dashboard, TypeScript SDK, 14 shared packages, CI/CD, Docker.
**Date:** 2026-09-08 · **Method:** full source review of every
security-critical path + live execution of the test/typecheck/build/audit
matrix in this session (evidence in §0).

---

## 0. Verification evidence (what was actually run)

| Check                                                               | Result                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` (pnpm 11.24, frozen-lockfile-compatible)             | ✅ Fixed — was **broken** (see F1)                                                                                                                                                                                                 |
| Gateway unit tests                                                  | ✅ **127/127** (10 suites)                                                                                                                                                                                                         |
| Gateway e2e (`x402-flow.e2e-spec.ts`)                               | ✅ **34/34**                                                                                                                                                                                                                       |
| `x402-core` tests (incl. new quote-window, timeout, property-based) | ✅ **66/66** (3 suites)                                                                                                                                                                                                            |
| `@x402/validation` tests (new suite + project test target)          | ✅ **25/25**                                                                                                                                                                                                                       |
| SDK tests                                                           | ✅ **15/15**                                                                                                                                                                                                                       |
| Full `nx run-many --target=test --all --coverage`                   | ✅ 6 projects green, coverage gates enforced                                                                                                                                                                                       |
| Gateway typecheck (`tsc -p apps/gateway/tsconfig.app.json`)         | ✅ 0 errors                                                                                                                                                                                                                        |
| Lint (`nx run-many --target=lint --all`, 15 projects)               | ✅ 0 errors                                                                                                                                                                                                                        |
| `pnpm audit`                                                        | ✅ **0 critical, 0 runtime-reachable**; 54 → **2 high** after the NestJS 11 / Next 15 + nx 22 major upgrades, both `image-size` (no patched release, unused vite/less chain — see F8)                                              |
| Secret scan (grep for keys/private keys across repo)                | ✅ none found                                                                                                                                                                                                                      |
| Soroban contracts (`cargo test`)                                    | ✅ **25 / 44 / 33 pass locally** (Rust 1.98.1 + soroban-sdk 22, incl. the new gas/storage benches); WASM sizes 6.6 / 8.5 / 6.9 KiB — see GAS-OPTIMIZATION §5.5                                                                     |
| Live Stellar Testnet journey (stellar CLI 28, fresh funded account) | ✅ all 3 contracts deployed + initialized; `record_payment` live, **replay rejected** (VM trap), `is_payment_used=true`, multisig propose→approve (quorum, fail-closed transfer), escrow balance=0 — evidence in DEPLOYMENT §6.1.1 |

---

## 1. Findings fixed in this pass

### F1 — Blocker: pnpm workspace config broken for pnpm ≥ 10/11

`pnpm-workspace.yaml` contained an `allowBuilds` block with literal
`set this to true or false` placeholders, and the `pnpm` field in
`package.json` (overrides + `onlyBuiltDependencies`) is **ignored by pnpm
11** — so `pnpm install` errored (`ERR_PNPM_IGNORED_BUILDS`), the `koa`
override silently didn't apply, and CI's `PNPM_VERSION: latest` (deploy
workflow) was broken. Dockerfiles pinned pnpm 9 while CI deploy used latest.

**Fix:** migrated settings to `pnpm-workspace.yaml` (`allowBuilds` booleans
for the 7 packages that legitimately run install scripts + `overrides`),
removed the dead `pnpm` field, pinned CI (`ci.yml` → `11`,
`deploy.yml` → `11`) and both Dockerfiles (`corepack prepare pnpm@11`).
`pnpm install` is green.

### F2 — Payment-window integrity: historical-hash reuse (quote lower bound)

`verifyStellarPayment` only rejected payments made **after** quote expiry.
A payment made **before** the quote was issued (any historical payment to the
provider's address — public on Horizon) could be presented against a fresh
quote for one free access; the single-use guards only stop _re_-use, not
first use of an old hash.

**Fix:** `Quote` now carries `issuedAt` (set at generation, `expiresAt =
issuedAt + window`); verification rejects `txTime < issuedAt`
(`Payment was made before the quote was issued`) while skipping the check
defensively for legacy stored quotes. Tested (3 new cases incl. the exact
boundary and backward-compat).

### F3 — No timeouts on Horizon/Soroban fetches

Every chain fetch was a bare `fetch` — a hung Horizon/RPC held request
handlers open indefinitely (worker exhaustion).

**Fix:** `AbortSignal.timeout` on every Horizon fetch in `verifyStellarPayment`
and every Soroban RPC call (`contract-client`), config-driven
(`HORIZON_TIMEOUT_MS` / `SOROBAN_RPC_TIMEOUT_MS`, default 10 s), plus
server-level `requestTimeout`/`headersTimeout`. Tested with an
abort-signal-honoring mock.

### F4 — Streaming backpressure

`res.write(value)` ignored backpressure — a slow consumer made the gateway
buffer the entire upstream stream in memory.

**Fix:** `write() === false` → await `drain`/`close` (with a test-safe
fallback). All 18 proxy-service tests green.

### F5 — Request-size / memory bounds

Body cap existed (1 MB) but the zod schema allowed unbounded message arrays /
content / `max_tokens`.

**Fix:** `≤ 128 messages`, `≤ 64 KiB content`, `max_tokens ≤ 1,000,000`.
Tested (boundary + rejection cases).

### F6 — Health: liveness vs readiness missing

`/health` was a static 200 — no dependency checks, so orchestrators could not
drain a gateway with a dead DB/Redis.

**Fix:** `/health` + `/health/live` (liveness) and `/health/ready`
(Postgres `SELECT 1` + Redis `PING`, **503** with per-dependency detail).
Tested (4 cases). Docker HEALTHCHECK added to both images.

### F7 — Observability: no metrics endpoint

No Prometheus surface existed.

**Fix:** `GET /metrics` (outside the `api/v1` prefix) via a new
`MetricsService` (prom-client): `http_requests_total`,
`http_request_duration_ms`, `x402_quotes_generated_total`,
`x402_payments_verified_total`, `x402_payment_verification_failed_total`,
`x402_upstream_failures_total`, `x402_upstream_retries_total`,
`x402_circuit_breaker_opens_total`, `x402_underpayment_debts_recorded_total`,
`x402_onchain_record_failures_total` + default Node metrics. Instrumented the
quote/verify/forward/debt hot paths; a global interceptor records every HTTP
request. Tested. Grafana dashboard JSON included (`docs/dashboards`).

### F8 — Dependency posture: 0 critical, 0 runtime-reachable

`pnpm audit`: **76 advisories (34 high, 36 moderate)** at baseline. Phase 1
(overrides in `pnpm-workspace.yaml` — real, installable patched versions):
`express ≥5.2.1`, `ws ≥8.21.0`, `body-parser ≥1.20.6`, `qs ≥6.16.0`,
`uuid ≥11.1.1 <12` (12+ is ESM-only — would break the CJS NestJS
integration), `lodash ≥4.18.1`, `js-yaml ≥4.3.1`, `toml ≥4.2.0`,
`postcss ≥8.5.23`, `file-type ≥21.3.2`, `minimatch ≥9.0.7`,
`serialize-javascript ≥7.0.5`, `fast-uri ≥3.1.6`, `adm-zip ≥0.6.0`.
Phase 2 (major upgrades, 2026-09-08): **NestJS 10 → 11.2.3** (Express
5.2.1; platform-express ≥11.1.28 pins **multer 2.2.0**, lifting the ESM/CJS
blocker) and **Next 14 → 15.5.25** (React 19, recharts 2.15.4). Result:
**2 high advisories (0 critical, 0 runtime-reachable)** — remaining are
dev/build-tooling only, both `image-size` (no patched release exists; unused
`@nx/vite`→less chain). The nx 22 migration (2026-09-08) cleared the `nx`
19.5.7 / `webpack-dev-server` 4 / `brace-expansion` tracks. Tracks:
`MAINNET_READINESS.md` §7.

### F9 — CI security pipeline

Added: **gitleaks** (secret scan over full history, fail-on-leak),
**trivy** fs scan (HIGH/CRITICAL → SARIF → GitHub Security tab),
**osv-scanner** (npm + Cargo.lock), **SBOM** (CycloneDX) attached to every
`v*` release, `pnpm audit` upgraded to a documented critical gate with a
non-blocking high+ report. Install scripts now governed by the
`allowBuilds` allowlist.

### F10 — Container hardening

Both Dockerfiles: run as **non-root** (`USER node`), `HEALTHCHECK` on
`/health` (gateway) and `/` (dashboard), OCI provenance labels. Consistent
pnpm 11 across Docker + CI.

### F11 — Documentation (new)

`ARCHITECTURE.md`, `THREAT-MODEL.md`, `GAS-OPTIMIZATION.md`, `API.md`,
`OPERATIONS.md` (RTO/RPO, backup/restore, DR, runbooks), `OBSERVABILITY.md`
(+ Grafana dashboard), updated `SECURITY.md` / `DEPLOYMENT.md` /
`MAINNET_READINESS.md` / `README.md`.

---

## 2. Findings that required judgment (left as-is, documented)

| #   | Finding                                                 | Decision                                                                                                                                                                                                                     | Where                                                                   |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| J1  | ~~Next 14 → 15 / NestJS 10 → 11 major upgrades~~        | **DONE 2026-09-08** — NestJS 11.2.3 (Express 5.2.1, multer 2.2.0) + Next 15.5.25 (React 19); all gateway unit/e2e + dashboard build green                                                                                    | resolved; remainder is the nx 22 toolchain track (MAINNET_READINESS §7) |
| J2  | ~~Soroban gas/storage benchmarks~~                      | **DONE 2026-09-08** — Rust toolchain installed (1.98.1), `src/bench.rs` per contract measures fee/entries at 1→1k/10k history and asserts the O(1) gate; results ledger in GAS-OPTIMIZATION §5.5; WASM size gate added to CI | GAS-OPTIMIZATION.md §5.5; CI `contracts` job (benches + size gate)      |
| J3  | Rate limiting is IP-only                                | Accepted residual; the confirmed-payment tier cannot be spoofed by headers; single-use enforcement is the backstop                                                                                                           | SECURITY.md residual 2                                                  |
| J4  | Escrow settlement opt-in/experimental (fire-and-forget) | Product decision; disabled for mainnet v1                                                                                                                                                                                    | MAINNET_READINESS §5                                                    |
| J5  | Third-party contract audit                              | **The** mainnet gate — a trust decision, not technical                                                                                                                                                                       | MAINNET_READINESS §1                                                    |

---

## 3. Verified security invariants (regression-anchored)

Each invariant below has automated tests that fail if it regresses:

1. **Single-use payments** — same hash twice → second 402 (Redis `SET NX`
   race + DB unique + on-chain `USED_TX`); concurrent claim losers get
   `null`.
2. **Quote window** — payment before `issuedAt` or after `expiresAt` → 402.
3. **Underpayment enforcement** — per-token deposit ≤ payment; actual cost
   metered; deficits recorded as open per-(payer, provider) debt; access
   gated until a top-up covering deposit + debt clears the ledger.
4. **Asset/issuer exactness** — wrong asset, wrong issuer, wrong recipient,
   native-vs-USDC, path-payment refusal on mainnet policy.
5. **Amount math** — stroop↔unit round-trips under 500 randomized inputs per
   property; quote clamping ≥ `MIN_PAYMENT_AMOUNT`; price arithmetic
   identities.
6. **Auth** — challenge single-use/expiry, JWT issuer+secret, session store,
   provider-scoped multi-tenancy on every query, `AUTH_DEV_MODE`
   production boot-refusal, mainnet network-consistency boot guard.
7. **SSRF** — public-IP-only upstreams/webhooks (DNS-resolved, IPv4+IPv6,
   private/CGNAT/metadata ranges), DNS-rebind re-validation at proxy time,
   webhook re-validation at delivery.
8. **Contracts** — admin auth on all mutators, double-init rejection,
   multisig rotation quorum, escrow idempotency/insufficient-balance,
   pagination clamping, TTL-on-write-only.

---

## 4. Test & coverage posture

| Area                                  | Count / gate                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway unit                          | 135 tests, 12 suites; coverage thresholds 70% (statements/lines)                                                                                                                                                                                                                                                                                             |
| Gateway e2e                           | 35 tests (self-contained; mocks DB/Redis; covers 402 flow, replay, debt-gate, streaming, W3C trace propagation)                                                                                                                                                                                                                                              |
| x402-core                             | 66 tests incl. **deterministic property-based** suites (seeded PRNG, 500 iters/property)                                                                                                                                                                                                                                                                     |
| validation                            | 25 tests (new target — was untested)                                                                                                                                                                                                                                                                                                                         |
| notifications                         | 8 tests (new target — idempotent delivery, stable eventId + signed body across retries)                                                                                                                                                                                                                                                                      |
| SDK / config / wallet / dashboard-lib | 15 / existing / existing / existing, all green                                                                                                                                                                                                                                                                                                               |
| Contracts                             | 29 / 46 / 36 tests under `cargo test` — hand-written edge cases PLUS **deterministic property-based suites** (`src/property.rs` per contract: payment-verifier replay-set semantics, credit-escrow deposit→charge→refund→withdraw accounting walk, multisig pagination-window + quorum-ordering + rotation invariants; seeded PRNG, no external fuzz runner) |

Measurable targets vs. maturity bar: e2e thresholds were ratcheted again
(56% stmts / 25% branches / 37% funcs / 53% lines) and unit thresholds hold
at 70%. Contract property/fuzz suites (previously an open gap — see the old
THREAT-MODEL §6 and GAS-OPTIMIZATION §6 items) are now **implemented and
CI-gated**; the remaining **next ratchet** is raising e2e thresholds further
as scenarios are added — tracked in `GAS-OPTIMIZATION.md` §6 and
`MAINNET_READINESS.md` §1.

---

## 5. Security tooling (automated)

| Tool                      | Where             | Gate                                 |
| ------------------------- | ----------------- | ------------------------------------ |
| `pnpm audit`              | CI `security`     | fail on **critical**; high+ reported |
| gitleaks                  | CI `gitleaks`     | fail on any secret in history        |
| trivy (fs, HIGH/CRITICAL) | CI `trivy`        | report + SARIF to Security tab       |
| osv-scanner (npm + cargo) | CI `osv-scanner`  | report                               |
| SBOM (CycloneDX)          | deploy.yml `sbom` | release asset                        |
| pnpm `allowBuilds`        | workspace config  | install-script allowlist             |
| grep-based secret scan    | this audit        | ✅ clean                             |

---

## 6. Operational readiness

- **Health**: `/health` + `/health/live` (liveness), `/health/ready`
  (Postgres + Redis, 503 detail) — Docker `HEALTHCHECK` wired.
- **Metrics + alerts**: `/metrics` (Prometheus), alert rules A1–A7
  (verification-failure spikes, upstream/circuit failures, on-chain record
  failures, 5xx, latency, readiness) in `OBSERVABILITY.md`.
- **RTO/RPO**: Postgres 15 min RPO / 60 min RTO; Redis AOF; contracts are
  on-chain (RPO 0); full DR runbooks in `OPERATIONS.md`.
- **Fail-closed verification**: Horizon errors → 5xx, never false acceptance.

## 7. Verdict

The codebase was already genuinely well-engineered (triple-layer replay
protection, real SSRF guards, tested contracts, honest docs). This pass
closed the concrete gaps a production-grade review finds: a **broken
installer**, an **open payment-window integrity hole**, **no network timeouts**,
**no readiness/metrics surfaces**, **76 (incl. 34 high) dependency
advisories**, **no secret/container/SBOM scanning**, and **root-running
containers**. All tests, typecheck, lint, and the dependency gate are green
in this session; the remaining items are honest, tracked residuals —
**external contract audit** (mainnet gate), **major-version dependency
tracks**, and **executed gas benchmarks** (methodology + ledger provided;
execution requires the Rust toolchain / CI).

_Generated 2026-09-08 by automated audit + hardening pass._
