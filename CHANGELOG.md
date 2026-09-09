# Changelog

All notable changes to the x402 LLM Gateway project.

---

## [0.2.0] — 2026-09-08

### Security

- **Quote-window integrity:** `issuedAt` added to `Quote`; payments made
  before quote issuance are rejected (prevents replay of pre-issuance txs)
- **Network timeouts:** config-driven `HORIZON_TIMEOUT_MS` /
  `SOROBAN_RPC_TIMEOUT_MS` wired through x402-core and contract clients
- **Redis fail-fast:** bounded retry strategy + connect timeout so a down
  Redis fails startup instead of hanging forever
- **Dependency posture:** NestJS 10 → **11.2.3** (Express 5.2.1, multer
  2.2.0), Next 14 → **15.5.25** (React 19), **nx 19.5 → 22.7.9**
  (eslint-config-prettier 10), plus overrides for express/ws/body-parser/qs/
  uuid/lodash/js-yaml/toml/postcss/file-type/minimatch/serialize-javascript/
  fast-uri/adm-zip — **0 critical, 0 runtime-reachable advisories**; the 9
  dev-tooling advisories dropped to **2 high** with the nx 22 migration, both
  `image-size` (via the unused @nx/vite→less chain; no patched release exists)
  — see `MAINNET_READINESS.md` §7
- **Build fix:** the nx 22 tree pulled `supports-color@7.2.0` into the
  `@babel/core` peer chain, splitting `next` into two store instances (root
  `.bin/next` vs `apps/dashboard` resolved different copies, breaking the
  pages-router `/404` prerender with the `<Html>` context error); pinning
  `supports-color: 8.1.1` collapses the tree to one instance — `next build`
  green again
- **Input validation:** message/content bounds hardened in `@x402/validation`

### Observability & operations

- **Prometheus `/metrics`** endpoint with HTTP request counters/durations,
  provider, debt, and circuit-breaker metrics + Grafana dashboard
- **Liveness/readiness:** `/health/live` and `/health/ready` with real
  Postgres/Redis dependency checks (503 when unhealthy)
- **Streaming backpressure** in proxy stream forwarding
- **Docker hardening:** non-root users, healthchecks, OCI labels
- **CI/CD:** gitleaks, trivy, osv-scanner, SBOM (CycloneDX) jobs; pnpm 11
  migration (workspace `allowBuilds`/`overrides`)

### Docs

- New: `ARCHITECTURE.md`, `THREAT-MODEL.md`, `API.md`, `GAS-OPTIMIZATION.md`,
  `OPERATIONS.md` (RTO/RPO, backup/DR), `OBSERVABILITY.md`; rewritten
  `AUDIT.md`; updated `SECURITY.md` / `DEPLOYMENT.md` /
  `MAINNET_READINESS.md` / `README.md`

---

## [0.1.0] — 2026-08-11

### Added

- **Gateway:** Reverse proxy with HTTP 402 Payment Required flow for LLM APIs
- **Gateway:** Flat-rate and per-token pricing models with metered billing
- **Gateway:** Triple-layered replay protection (Redis SET NX → on-chain contract → DB unique constraint)
- **Gateway:** SSRF guards for webhook and upstream URLs with DNS resolution
- **Gateway:** Rate limiting (paid/unpaid tiers, sliding-window Redis Lua script)
- **Gateway:** Circuit breaker for upstream LLM failures
- **Gateway:** Streaming (SSE) support for chat completions
- **Gateway:** Multi-tenant isolation — all data scoped by authenticated wallet
- **Gateway:** Audit logging of all gateway operations
- **Gateway:** Webhook notifications with HMAC signatures and retry logic
- **Gateway:** Wallet-based authentication (challenge-response with Stellar keys)
- **Gateway:** Escrow settlement via credit-escrow Soroban contract (charge + refund)
- **Dashboard:** Next.js provider dashboard with route/payment management
- **Dashboard:** Real-time analytics (summary, time series, top callers/routes)
- **Dashboard:** Wallet authentication (Freighter, xBull, Albedo)
- **SDK:** TypeScript client with automatic 402 → pay → retry flow
- **SDK:** Streaming support via async generators
- **SDK:** External wallet signing (publicKey + signTransaction)
- **Contracts:** Payment Verifier — on-chain payment recording with replay protection
- **Contracts:** Credit Escrow — prepaid balance management with idempotent charge/refund
- **Contracts:** Multisig Wallet — M-of-N signer approval for provider payouts
- **CI/CD:** Lint → unit tests (coverage thresholds) → E2E → contract tests → security audit
- **CI/CD:** Docker images for gateway and dashboard
- **CI/CD:** Railway + Vercel deployment configs
- **Docs:** README, DEPLOYMENT.md, SECURITY.md, CONTRIBUTING.md, AUDIT.md

### Fixed (from audit — Phase 1)

- **C2:** SDK external signer path now works (`publicKey` + `signTransaction`)
- **C5:** Streaming responses now include receipt/cost as trailing SSE event
- **M2:** `minPaymentAmount` enforced in quote generation and payment verification
- **M4:** RateLimitGuard added to PaymentsController public status endpoint
- **C1:** Escrow settlement wired into proxy controller (charge + auto-refund surplus)

### Fixed (from audit — Phase 2)

- **M6:** DNS rebinding protection added at proxy-forward time (`813fed7`)
- **M10:** Email notification channel wired with nodemailer (`09e4706`)
- **L9:** Jest unit test scaffolding added for dashboard pages and components (`05e10c9`)
- **M3:** Credit-escrow invariant tests added for balance equation (`b49a2d1`)
- **L4:** CHANGELOG.md, git tags, and release cadence established
- **L2:** `contracts/deployed-addresses.json` committed and tracked

### Known Limitations

- Circuit breaker is in-memory only (not shared across gateway instances)
- SDK unit tests remain at 0% coverage (targeted as [#45](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/45))
- Escrow settlement is partially wired (credit-escrow contract exists but gateway settlement path is incomplete — [#25](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/25))
- Streaming receipt headers are not yet set (`X-Payment-Receipt` empty on SSE — [#29](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/29))
- API key / session tables in Prisma schema are dead code — [#47](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/issues/47)
