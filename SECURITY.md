# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the x402 LLM Gateway, please report it responsibly.

**Do not open a public GitHub issue.**

Instead, [open a private security advisory](https://github.com/Pay-Per-Token-LLM-Gateway/pay-per-token-llm-gateway/security/advisories/new) or email the maintainers with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you on a fix.

## Security Documentation

- **[`THREAT-MODEL.md`](./THREAT-MODEL.md)** — full threat model: assets,
  trust boundaries, and per-threat mitigations across the gateway,
  contracts, SDK, and dashboard (updated 2026-09-08).
- **[`AUDIT.md`](./AUDIT.md)** — audit findings ledger with verification
  evidence.
- **[`MAINNET_READINESS.md`](./MAINNET_READINESS.md)** — the go/no-go gate
  for a Stellar mainnet launch.
- **[`OPERATIONS.md`](./OPERATIONS.md)** — RTO/RPO, backup/restore, disaster
  recovery, runbooks.

## Security Model

### Trust Assumptions

1. **Stellar blockchain is the single source of truth** — all payments are verified on-chain
2. **Client payment proofs are never trusted** — Horizon/Soroban RPC queries are mandatory
3. **Upstream LLM API keys are server-side only** — never exposed to callers

### Replay Protection (single-use payments)

Transaction hashes are consumed through **three independent layers**:

1. **Redis** — atomic `SET NX` claim (`x402:replay:*`, TTL `PAYMENT_CACHE_TTL`);
2. **On-chain** — the Soroban `payment-verifier` `USED_TX` guard (permanent,
   survives Redis loss, shared across gateway instances);
3. **PostgreSQL** — atomic `updateMany({ txHash: null })` + unique index.

Any one layer rejecting is sufficient to refuse access. In production, run
Redis with AOF persistence so restart windows are minimized.

### Payment verification invariants

- Amount matches the pricing model (flat: exact; per-token: ≥ deposit).
- Asset **and** issuer match the quote (`USDC_ISSUER`); mainnet refuses a
  non-Circle issuer at boot.
- The payment timestamp must fall **inside** `[quote.issuedAt, quote.expiresAt]`
  — payments made before the quote was issued (historical-hash reuse) or
  after it expired are rejected.
- Mainnet accepts direct `payment` operations only (no path payments).
- All Horizon/Soroban RPC fetches are timeout-bounded (default 10 s) — a hung
  chain endpoint can never hold a request open indefinitely.

### Rate Limiting

Unpaid 402 requests are rate-limited by caller IP (sliding window, Redis
Lua). Requests carrying a **confirmed** payment hash get a higher tier — the
mere presence of a header never raises the limit. Behind a trusted proxy,
`TRUST_PROXY` resolves the real client IP; a directly-exposed gateway must
set `TRUST_PROXY=0` (spoofing `X-Forwarded-For` is otherwise possible).

### Key Management

- Upstream LLM API keys are environment variables: `UPSTREAM_API_KEY_<PROVIDER_ID>`
- JWT secrets must be at least 256 bits; the gateway refuses to boot with a
  missing or known-placeholder `JWT_SECRET`.
- `AUTH_DEV_MODE=true` (any-wallet dev signature bypass) is refused at boot
  when `NODE_ENV=production`.
- Payment verification uses only public keys — no Stellar secret is needed to _verify_ payments
- `CONTRACT_ADMIN_SECRET` (records payments on-chain and settles escrow) is
  stored server-side. Custody matters: keep it in a secret manager, fund it
  with XLM, and rotate it like any other signing key.

### Audit

All payment verifications, request forwarding, debt events, and admin
actions are logged to the `AuditLog` table for forensic analysis; the on-chain
`payment-verifier` contract keeps an immutable audit trail of every recorded
payment.

## Automated security scanning (CI)

| Scan                                      | Tool                      | Gate                                                                |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------- |
| npm/pnpm advisories                       | `pnpm audit`              | **fail on critical**; high+ reported                                |
| Secret scanning (full git history)        | gitleaks                  | **fail on any leak**                                                |
| Container/filesystem vulnerabilities      | trivy (fs, HIGH/CRITICAL) | report → GitHub Security tab (SARIF)                                |
| Lockfile vulnerability scan (npm + cargo) | osv-scanner               | report                                                              |
| SBOM (CycloneDX, per release)             | anchore sbom-action       | release asset                                                       |
| Install-script allowlist                  | pnpm `allowBuilds`        | only prisma/esbuild/nx/@nestjs-core/@parcel-watcher may run scripts |

Dependency posture (2026-09-08): **0 critical** and **0 runtime-reachable**
advisories. The gateway runs **NestJS 11.2.3 on Express 5.2.1** (with multer
2.2.0 pinned by platform-express) and the dashboard runs **Next 15.5.25 +
React 19** — the three previously-tracked major-version residuals are
resolved, and the nx 22 migration cleared the remaining dev-tooling track
(`brace-expansion` fixed via scoped override). `pnpm audit` now reports **2
high advisories, both `image-size`** — dev/build-tooling only, via the unused
`@nx/vite`→less chain, no patched release exists, no runtime-reachable path —
see `MAINNET_READINESS.md` §7.

## Known Residual Risks

Accepted, documented limitations as of September 2026. These are on the
mainnet go/no-go path or consciously deferred — see
[`MAINNET_READINESS.md`](./MAINNET_READINESS.md) for the full gate.

1. **Soroban contracts are not independently audited.** payment-verifier,
   credit-escrow, and multisig are self-tested only (23 / 43 / 32 unit tests,
   no external review). An independent audit is required before handling real
   USDC on mainnet.
2. **Rate limiting is per IP only.** Wallet-address-based limiting is not
   implemented. Callers behind a shared NAT can rotate through addresses to
   evade it; single-use payment enforcement (atomic DB claim + Redis +
   on-chain replay guards) is the stronger backstop.
3. **Dev/build-tooling advisories remain** (2 high, both `image-size` — no
   patched release exists; via the unused `@nx/vite`→less chain). Build-time
   only, never shipped to runtime, with no runtime-reachable path. Tracked in
   `MAINNET_READINESS.md` §7.
4. **Per-entry persistent storage TTLs.** Soroban records each carry their
   own TTL, refreshed on write. An entry untouched for ~1M ledgers after its
   last write may require a paid restore-from-archive read to be read again.
5. **Verification is fail-closed.** If Horizon errors or times out during
   payment verification the request fails with a 5xx — valid payments are
   never falsely accepted, but a Horizon outage blocks all paid traffic until
   it recovers. Use dedicated RPC providers and monitor verification failures.
6. **Mainnet safety depends on operator config.** `STELLAR_NETWORK`, Horizon /
   Soroban RPC URLs, the network passphrase, and the USDC issuer are
   operator-set. A "mainnet" gateway pointed at testnet endpoints would verify
   worthless testnet payments and serve real LLM compute for them (boot-time
   consistency guard enforced in `packages/config`).
7. **Underpayment settlement is gateway-side, not on-chain.** Per-token
   debt gating runs in the gateway DB (testnet-appropriate); on-chain escrow
   settlement is opt-in and experimental.
8. **Quote front-running is griefing-only.** A third party can pay a victim's
   quote first (the attacker loses real funds; the victim re-quotes). Memo
   enforcement is deliberately off.

## Security Checklist for Production

- [ ] Use a dedicated Horizon/Soroban RPC provider with API keys
- [ ] Enable Redis persistence (AOF)
- [ ] Run behind Cloudflare/NGINX with TLS and the correct `TRUST_PROXY` setting
- [ ] Set up monitoring alerts for failed verifications (OBSERVABILITY.md A1–A7)
- [ ] Rotate JWT secrets regularly
- [ ] Use separate Stellar accounts for receiving payments vs. payouts
- [ ] Implement withdrawal limits for provider payouts
- [ ] Fund `CONTRACT_ADMIN_SECRET`'s account with XLM and alert on low balance
- [ ] Regular security audits of the codebase + external contract audit before mainnet
