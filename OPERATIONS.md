# OPERATIONS.md

> Operational runbook for the x402 LLM Gateway: backup/restore, disaster
> recovery, RTO/RPO targets, health/readiness, alerting, and failure
> runbooks. Companion to [`DEPLOYMENT.md`](./DEPLOYMENT.md) (how to deploy)
> and [`OBSERVABILITY.md`](./OBSERVABILITY.md) (what to watch).
> Last updated: **2026-09-08**.

## 1. Recovery objectives (RTO / RPO)

| Tier | Asset                                                          | RPO (max data loss)  | RTO (max downtime) | Method                                                                                                         |
| ---- | -------------------------------------------------------------- | -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| T1   | PostgreSQL (payments, routes, debts, audit)                    | 15 min               | 60 min             | Postgres `pg_dump` every 15 min to object storage + WAL archiving (or managed PITR)                            |
| T2   | Redis (replay claims, rate limits, sessions, circuits)         | 1 h (AOF `everysec`) | 30 min             | AOF persistence + replica; replay claims re-verify against Soroban `USED_TX` on recovery                       |
| T3   | Soroban contracts                                              | 0 (on-chain)         | 0 (network)        | Contracts are immutable state on Stellar — nothing to back up; re-deploy WASM + admin keys from secret manager |
| T4   | Dashboard (Next.js)                                            | n/a (stateless)      | 15 min             | Rebuild + redeploy from the release tag                                                                        |
| T5   | Secrets (`JWT_SECRET`, `CONTRACT_ADMIN_SECRET`, upstream keys) | 0                    | 15 min             | Secret manager (no backups — rotate on compromise)                                                             |

**Combined worst case:** 15 min data loss, 60 min to fully serve traffic
again.

## 2. Backup procedures

### 2.1 PostgreSQL

```bash
# Full dump (daily) + encrypted upload
pg_dump "postgresql://x402:…@db:5432/x402_gateway" --format=custom \
  | gpg --encrypt --recipient <ops-key> -o /backups/x402-$(date +%F-%H%M).dump.gpg

# Restore (DR):
gpg --decrypt /backups/x402-latest.dump.gpg | pg_restore \
  --dbname "postgresql://x402:…@newdb:5432/x402_gateway" --clean --if-exists
```

- Keep hourly dumps for 7 days, daily for 30 days, monthly for 12 months.
- **Test restore monthly** — an untested backup is not a backup.
- Prisma migrations: on restore, the schema is embedded in the dump; then run
  `pnpm db:migrate` only for post-restore schema drift (review first).

### 2.2 Redis

- Run with `--appendonly yes` (already the compose default) and
  `appendfsync everysec`; persist `dump.rdb`/AOF to a mounted volume.
- **Replay-protection note:** even with total Redis loss, payment replay is
  still blocked by the on-chain `USED_TX` guard and the Postgres single-use
  rows — the gateway will reject already-consumed hashes. Redis loss is an
  availability blip (rate limits reset), not a security break.

### 2.3 Contracts & keys

- `contracts/deployed-addresses.json` is committed; the deployed instances
  are authoritative.
- `CONTRACT_ADMIN_SECRET` / `STELLAR_SECRET_KEY` / `JWT_SECRET` / upstream
  keys live in the secret manager only. There is **no backup** — rotate on
  any suspicion.

## 3. Disaster recovery scenarios

### 3.1 Postgres down (region-level)

1. Point the gateway at the PITR-restored DB (or failover replica).
2. Gateway readiness (`/health/ready`) reports `database: down` until then —
   orchestrators must stop routing traffic (this is why readiness exists).
3. On recovery, reconcile: `Payment` rows are authoritative for billing; the
   Soroban `USED_TX` set can rebuild any missed replay claims (query the
   contract) — replay safety is preserved.

### 3.2 Redis down

1. Gateway keeps serving: rate limits reset, claims fall back to DB+on-chain
   layers (a hash claimed in Redis but lost is re-checked on-chain and
   rejected if recorded).
2. Sessions are lost — dashboard users re-authenticate (challenge flow).

### 3.3 Full region loss

1. Restore Postgres from the newest dump (T1).
2. Start Redis (AOF) or fresh (T2 semantics above).
3. Redeploy gateway + dashboard from the release tag; set env from the
   secret manager.
4. Contracts: already on-chain; no action. Verify `deployed-addresses.json`
   matches the live instances (`stellar contract id` vs config).

### 3.4 Admin-key compromise

1. Rotate `CONTRACT_ADMIN_SECRET` in the secret manager.
2. Deploy a **fresh payment-verifier** with the new admin (`init(newAdmin)`),
   record the new ID in config; `set_admin` on the old contract is the
   in-place alternative if the old key is still usable.

## 4. Health & readiness

| Endpoint                  | Semantics                                                               | Consumers                       |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| `/health`, `/health/live` | Process up (no dependencies)                                            | Docker HEALTHCHECK, LB liveness |
| `/health/ready`           | Postgres + Redis reachable; **503** with per-dependency detail when not | K8s/Railway readiness, LB drain |

Runbook: a red `/health/ready` with `database: down` → check Postgres
connectivity/credentials; `redis: down` → check Redis + AOF mount. The
gateway is designed to fail **closed** on verification paths (never falsely
accept a payment), so availability incidents surface as 5xx on the proxy —
see alert A5.

## 5. Runbooks (quick)

| Symptom                                        | First actions                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `x402_payment_verification_failed_total` spike | Check Horizon status page; check RPC API keys/quotas; verify `HORIZON_URL`                                                           |
| `x402_upstream_failures_total` spike           | Check circuit-breaker state (`x402_circuit_breaker_opens_total`); provider API keys; upstream status                                 |
| `x402_onchain_record_failures_total` > 0       | Soroban RPC unreachable or admin key low on XLM → top up the admin account (see MAINNET_READINESS §3.1)                              |
| Debt-gate denials spike                        | Check `UnderpaymentDebt` table; pricing config sanity; payer behavior                                                                |
| Rate-limit 429 storms                          | Verify `TRUST_PROXY` matches topology; raise `RATE_LIMIT_MAX` for known-good IPs via Redis                                           |
| Readiness red (DB)                             | PITR failover; restore from backup per §2.1                                                                                          |
| Readiness red (Redis)                          | Start Redis with AOF; expect session loss                                                                                            |
| Unexpected 402s for valid payments             | Verify quote-window check: payment must be dated after `issuedAt` (a reused _old_ hash is now correctly rejected); get a fresh quote |

## 6. Deployment hygiene

- Deploy only tag-triggered (`v*`) — CI gate + contract deploy + SBOM
  attachment happen automatically (`.github/workflows/deploy.yml`).
- Apply Prisma migrations explicitly (`pnpm db:migrate`) before rolling the
  gateway; never `db:push` against production without a reviewed diff.
- Rotate `JWT_SECRET` and upstream keys on a schedule; keep
  `CONTRACT_ADMIN_SECRET` in a secret manager.
- Track RTO/RPO: record restore drills in the audit log of the ops repo.
