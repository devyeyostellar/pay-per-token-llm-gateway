# x402 LLM Gateway — Deployment Guide

This guide covers deploying the two components of the x402 LLM Gateway:

| Component               | Platform | Type       | Why                                                           |
| ----------------------- | -------- | ---------- | ------------------------------------------------------------- |
| **Gateway** (NestJS)    | Railway  | Container  | Long-running server with WebSockets, needs PostgreSQL + Redis |
| **Dashboard** (Next.js) | Vercel   | Serverless | Next.js is natively supported with zero config                |

---

## Prerequisites

- GitHub repository with the code pushed
- A Stellar testnet account with secret key (generate one with the Stellar CLI: `stellar keys generate --global my-account --network testnet`, then fund it from the [Stellar testnet faucet](https://laboratory.stellar.org/#account-creator?network=test))
- Upstream LLM API key (e.g., OpenAI API key)

---

## Part 1: Deploy Gateway to Railway

### 1.1 Create Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub.

### 1.2 Add PostgreSQL and Redis

1. Click **New Project** → **Deploy from GitHub repo**
2. Select your x402-llm-gateway repository
3. Click **+ New** → **Database** → **Add PostgreSQL**
4. Click **+ New** → **Database** → **Add Redis**

### 1.3 Configure the Gateway Service

1. Select the gateway service from your repo
2. Under **Settings** → **Environment**, add:

| Variable                            | Value                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| `NODE_ENV`                          | `production`                                               |
| `STELLAR_NETWORK`                   | `testnet`                                                  |
| `DATABASE_URL`                      | `${{Postgres.DATABASE_URL}}` (Railway reference)           |
| `REDIS_URL`                         | `${{Redis.REDIS_URL}}` (Railway reference)                 |
| `JWT_SECRET`                        | (Generate: `openssl rand -base64 32`)                      |
| `USDC_ISSUER`                       | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `CORS_ORIGINS`                      | `https://your-dashboard.vercel.app`                        |
| `UPSTREAM_API_KEY_YOUR_PROVIDER_ID` | `sk-your-openai-api-key`                                   |
| `PORT`                              | `3000`                                                     |
| `HORIZON_TIMEOUT_MS`                | `10000` (optional, per-request Horizon timeout)            |
| `SOROBAN_RPC_TIMEOUT_MS`            | `10000` (optional, per-request Soroban RPC timeout)        |

3. Under **Settings** → **Build**, set:
   - **Dockerfile path**: `infrastructure/docker/Dockerfile.gateway`

4. Under **Settings** → **Deploy**, set:
   - **Health Check Path**: `/health`

### 1.4 Deploy

Click **Deploy**. The gateway will:

1. Build the Docker image
2. Connect to PostgreSQL and Redis
3. Run Prisma migrations
4. Start on port 3000

Note the gateway URL (e.g., `https://x402-gateway.up.railway.app`).

---

## Part 2: Deploy Dashboard to Vercel

### 2.1 Create Vercel Account

Go to [vercel.com](https://vercel.com) and sign up with GitHub.

### 2.2 Import the Project

1. Click **Add New** → **Project**
2. Select your x402-llm-gateway repository
3. Configure:

| Setting            | Value            |
| ------------------ | ---------------- |
| **Framework**      | Next.js          |
| **Root Directory** | `apps/dashboard` |

Leave **Build Command** and **Output Directory** empty — they're provided by
`apps/dashboard/vercel.json` (`pnpm exec next build` outputs `.next` inside
`apps/dashboard`, which is exactly where Vercel looks for it).

> ⚠️ Keep the build command as `next build` — not `nx build dashboard`.
> Vercel runs the command from the Root Directory (`apps/dashboard`), and the
> Nx `@nx/next:build` executor fails there with
> `ENOENT: scandir 'apps/dashboard/public'` on a cold cache.

### 2.3 Set Environment Variables

| Variable                  | Value                                 |
| ------------------------- | ------------------------------------- |
| `NEXT_PUBLIC_GATEWAY_URL` | `https://your-gateway.up.railway.app` |

> ⚠️ This value is baked into the client bundle at **build time**, so set it in
> the Vercel project → **Settings → Environment Variables** **before** the first
> build. If the gateway isn't deployed yet, use its future URL — the dashboard
> builds fine without it, but API calls will fail until it points at a live
> gateway.

### 2.4 Deploy

Click **Deploy**. Vercel will install the monorepo dependencies (via
`pnpm install --frozen-lockfile`), build the dashboard with `next build`, and
serve the `.next` output.

---

## Part 3: Initialize the Gateway

Once both services are deployed, initialize the gateway:

### 3.1 Create a Provider

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "My LLM Provider",
    "walletAddress": "YOUR_STELLAR_WALLET_ADDRESS",
    "payoutWalletAddress": "YOUR_PAYOUT_WALLET_ADDRESS"
  }'
```

### 3.2 Create a Route

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/routes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "providerId": "PROVIDER_ID_FROM_ABOVE",
    "path": "/v1/chat/completions",
    "upstreamUrl": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4",
    "pricingModel": "flat",
    "flatPrice": "1000000",
    "acceptedAssets": ["USDC"],
    "rateLimit": 10
  }'
```

---

## Part 4: Test the x402 Payment Flow

### 4.1 Send Request Without Payment (Expect 402)

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

**Expected Response (402):**

```json
{
  "status": 402,
  "message": "Payment Required",
  "quote": {
    "id": "...",
    "amount": "1000000",
    "asset": "USDC",
    "paymentAddress": "GA5ZSE...",
    "network": "testnet"
  }
}
```

### 4.2 Pay on Stellar Testnet

Using the Stellar CLI or any Stellar wallet, send the quoted amount to the payment address:

```bash
stellar tx new --source alice --network testnet \
  --op payment --destination YOUR_GATEWAY_ADDRESS \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --amount 0.1
```

### 4.3 Retry Request with Payment Hash

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment-Hash: YOUR_TRANSACTION_HASH" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

### 4.4 Expected Success Response

The gateway verifies the payment on-chain and proxies to the LLM:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [...],
  "usage": {...}
}
```

---

## Part 5: Mainnet Deployment

> ⚠️ **Mainnet moves real USDC.** Everything below assumes you have real
> funds, real accounts, and production-grade secrets. Test the full flow on
> testnet first (Parts 1–4).

### 5.1 Prerequisites

- The `stellar` CLI (v20+) and `jq` — for contract deployment
- A funded Stellar mainnet account (its secret key becomes the contract admin)
- Real mainnet USDC (the gateway uses Circle's official USDC issuer:
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`)
- Strong secrets: `openssl rand -base64 32` for `JWT_SECRET`,
  `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`

### 5.2 Deploy contracts to mainnet

The gateway reads its contract IDs from environment variables, so the
contracts must be deployed and initialized on mainnet before the gateway
starts. `scripts/deploy-contracts.sh` handles build, deploy, `init`, and
persisting the new IDs to `contracts/deployed-addresses.json`:

```bash
STELLAR_NETWORK=mainnet \
STELLAR_SECRET_KEY=S... \
USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
MULTISIG_SIGNERS=G... \
bash scripts/deploy-contracts.sh
```

Notes:

- The script defaults the Soroban RPC and network passphrase per network
  (mainnet → `https://soroban-mainnet.stellar.org` /
  `Public Global Stellar Network ; September 2015`), and only needs
  `STELLAR_SECRET_KEY` + `USDC_ISSUER` overridden.
- **You must pass the mainnet `USDC_ISSUER` explicitly** — the script's
  default is the testnet issuer.
- The deploying account's public key becomes the admin of
  `payment-verifier` and `credit-escrow`, and the default multisig signer.
- After deployment, copy the mainnet IDs from
  `contracts/deployed-addresses.json` into your environment
  (`PAYMENT_VERIFIER_CONTRACT`, `CREDIT_ESCROW_CONTRACT`,
  `MULTISIG_CONTRACT`).

### 5.3 Docker Compose (mainnet)

A hardened compose file is included:

```bash
docker compose -f infrastructure/docker/docker-compose.mainnet.yml up -d
docker compose -f infrastructure/docker/docker-compose.mainnet.yml ps
```

Unlike the dev file, it **fails fast when secrets are missing**:

| Variable                                                                     | Required | Purpose                                           |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| `POSTGRES_PASSWORD`                                                          | ✅       | Postgres password (fail-fast)                     |
| `REDIS_PASSWORD`                                                             | ✅       | Redis password (fail-fast)                        |
| `JWT_SECRET`                                                                 | ✅       | Session signing (fail-fast)                       |
| `CONTRACT_ADMIN_SECRET`                                                      | ✅       | On-chain payment recording (fail-fast)            |
| `PAYMENT_VERIFIER_CONTRACT` / `CREDIT_ESCROW_CONTRACT` / `MULTISIG_CONTRACT` | ✅       | Mainnet contract IDs (fail-fast)                  |
| `USDC_ISSUER`                                                                | –        | Defaults to Circle mainnet issuer                 |
| `CORS_ORIGINS`                                                               | –        | Defaults to the Vercel dashboard                  |
| `TRUST_PROXY`                                                                | –        | Set to your real proxy chain for IP rate limiting |

It pins `STELLAR_NETWORK=mainnet`, adds `restart: unless-stopped`, and
healthchecks every service. A full reference lives in `.env.mainnet.example`.

### 5.4 Railway deployment

Create a Railway project with PostgreSQL and Redis (same layout as Part 1),
then set the gateway service variables:

| Variable                                                                     | Mainnet value                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `NODE_ENV`                                                                   | `production`                                               |
| `STELLAR_NETWORK`                                                            | `mainnet`                                                  |
| `USDC_ISSUER`                                                                | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| `HORIZON_URL`                                                                | `https://horizon.stellar.org`                              |
| `SOROBAN_RPC_URL`                                                            | `https://soroban-mainnet.stellar.org`                      |
| `DATABASE_URL`                                                               | Railway Postgres URL                                       |
| `REDIS_URL`                                                                  | Railway Redis URL                                          |
| `JWT_SECRET`                                                                 | random 256-bit value                                       |
| `CONTRACT_ADMIN_SECRET`                                                      | mainnet admin secret key                                   |
| `PAYMENT_VERIFIER_CONTRACT` / `CREDIT_ESCROW_CONTRACT` / `MULTISIG_CONTRACT` | deployed mainnet IDs                                       |
| `TRUST_PROXY`                                                                | `1` (Railway) — adjust if you add Cloudflare               |

### 5.5 Security considerations

- **Real assets at stake**: start with small limits, verify a single real
  payment end-to-end, and monitor `X-Payment-Receipt` headers before
  scaling.
- **Secret management**: never put `CONTRACT_ADMIN_SECRET` or `JWT_SECRET`
  in git. Use Railway's encrypted variables, a secret manager, or a
  hardware-backed signer.
- **Rate limiting**: wallet-based and IP-based limits apply; set
  `TRUST_PROXY` correctly so the real client IP is seen.
- **Contract admin**: keep the admin account's signing key offline when
  possible; use the multisig contract for higher-value operations.
- **Audit trail**: on-chain payment records are permanent. Test refunds on
  a low-value account first.

### 5.6 Pre-launch checklist

- [ ] `cargo test` passes for all three contracts (see `contracts/`)
- [ ] Mainnet contracts deployed and initialized; IDs in env
- [ ] `STELLAR_NETWORK=mainnet` and mainnet `USDC_ISSUER` confirmed in the
      running config (`GET /health` or admin config view)
- [ ] Real USDC payment completes and receipt shows the real route
- [ ] `docker compose ps` shows all services `healthy`
- [ ] Secrets rotated, `.env.mainnet.example` never committed with values

---

## Part 6: Testnet verification journey & operations

### 6.1 Verifying the complete user journey on Stellar Testnet

Run this exact sequence against a testnet deployment (this is what the
automated e2e suite — `apps/gateway/src/e2e/x402-flow.e2e-spec.ts` — mocks;
the steps below exercise the live chain):

```bash
# 1. Liveness + readiness (dependencies up)
curl -s https://gateway/health && curl -s https://gateway/health/ready | jq .checks

# 2. Metrics endpoint is scrapeable
curl -s https://gateway/metrics | grep -E "x402_(quotes|payments)"

# 3. Unpaid request → 402 with a quote (capture quote.amount / quote.id)
curl -s -X POST https://gateway/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'

# 4. Pay the quoted amount from a funded testnet wallet to quote.paymentAddress
#    (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5), then:
curl -s -X POST https://gateway/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment-Hash: <tx_hash>" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
# → 200 with LLM response + X-Payment-Receipt header

# 5. Replay the SAME hash → expect 402 "This payment has already been used"

# 6. SDK smoke test (auto 402 → pay → retry)
node -e "
const { X402Client } = require('@x402/sdk');
const c = new X402Client({ gatewayUrl: 'https://gateway', secretKey: process.env.SK, network: 'testnet' });
c.call({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }).then(r => console.log(r.success ? 'OK ' + r.response.id : 'FAIL ' + r.error));
"
```

Negative checks to include in the rehearsal: wrong-issuer payment → 402;
payment older than the quote (reused historical hash) → 402 _before quote
issued_; amount below deposit (per-token route) → 402 "below the quoted
deposit"; expired quote → 402.

### 6.1.1 Live verification run — 2026-09-08 ✅

Executed against Stellar Testnet with a freshly friendbot-funded account
(stellar CLI 28.0.0, soroban-sdk 22, Rust 1.98.1). All three contracts were
**deployed fresh, initialized, and exercised live**; the artifacts are still
on testnet:

| Step                           | Result          | Evidence                                                                                                                 |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fund fresh account (friendbot) | ✅              | `GCZZNR5U5FVSSYIBAGMV7S6G46FSKSX3QF4I2SG7ADV6U6SNCGSYU5SJ`                                                               |
| Build WASM (release, opt)      | ✅              | `payment_verifier.wasm` 6,814 B                                                                                          |
| Deploy payment-verifier        | ✅              | `CADOAAAF6HCEVA4AL35HMMGAQQGFE5BROQAE6VUA4TNACGIMCULCP6OF`                                                               |
| `init(admin)`                  | ✅              | tx `2ef8ac2a…`                                                                                                           |
| `record_payment` (live)        | ✅              | tx `3c0a518a…` — `pay_verif` event emitted                                                                               |
| **Replay same tx_hash**        | ✅ **rejected** | VM trap `UnreachableCodeReached` (contract panicked "already recorded") — replay protection live                         |
| `is_payment_used`              | ✅ `true`       | read-only invoke                                                                                                         |
| `total_payments`               | ✅ `1`          | replay did not double-count                                                                                              |
| Deploy + init multisig         | ✅              | `CDYA65VZDNJEYSFQHTNS2Y4V67SP7GKW7PTYSWILPISUPH2MZPMDKUWE`                                                               |
| `propose` (payout path)        | ✅              | proposal #0, `proposed` event                                                                                            |
| `approve` → quorum             | ✅              | `approved` event emitted; transfer to unfunded token failed **closed** (`MissingValue`) — fail-closed behavior confirmed |
| Deploy + init credit-escrow    | ✅              | `CDCLIZ45BJUEXOJVJDQVU25VJRIMCF77B7TENHUZAR5JUCRITZQEJ4F3`; `balance` = 0                                                |

**Escrow lifecycle (deposit → charge → refund → revenue withdrawal) — verified
live 2026-09-08** with a self-deployed test token (own SAC admin, so minting
needs no issuer cooperation):

| Leg                                  | Result          | Evidence                                                   |
| ------------------------------------ | --------------- | ---------------------------------------------------------- |
| Deploy test SAC (`TUSDC`, own admin) | ✅              | `CDFD5KD7QRNOQTBEU42YHF42AXC3YSN3X3OMGNM345FFZQB62ZW44RRO` |
| Deploy + init escrow bound to it     | ✅              | `CCOZEFLX7ADDYFNFXR7F4IDGN47XVAYYD3SUUWM6OGZLAJP6VQYNXNO5` |
| Mint 1,000 → user                    | ✅              | user balance = 1,000                                       |
| `deposit` 800 (user-signs transfer)  | ✅              | escrow balance(user) = 800; trustline required first       |
| `charge` 250 (admin)                 | ✅              | balance 800→550; revenue 0→250; `usage` event              |
| **Replay charge (same quote)**       | ✅ **rejected** | VM trap; balance stays 550                                 |
| `refund` 50 (admin)                  | ✅              | escrow balance 550→500; user tokens +50                    |
| **Replay refund (same quote)**       | ✅ **rejected** | VM trap; balance stays 500                                 |
| `withdraw_revenue` 250 → admin       | ✅              | revenue 250→0; escrow tokens 750→500                       |
| **Accounting invariant**             | ✅              | escrow tokens (500) == escrow balance (500) + revenue (0)  |

Note on real USDC: the production USDC asset contract (`CBIELT…`) is
controlled by its own admin, so minting _real_ testnet USDC requires issuer
cooperation — this leg is covered by the e2e suite (mocked token) and unit
benchmarks; the payout transfer leg requires funding the multisig with real
testnet USDC (fail-closed when unfunded was verified live).

### 6.1.2 Live gateway journey run — 2026-09-09 ✅ (full-stack, reproducible)

The **complete user journey through the running gateway** — fund → trustlines
→ mint → unpaid 402 + quote → on-chain payment → 200 + receipt → replay
rejected → forged hash rejected → balance check — was executed live against
Stellar Testnet and passed every assertion. It is fully reproducible:

```bash
bash scripts/testnet-journey.sh
```

The script boots Postgres + Redis (Docker), applies the real migration
history to a fresh database, builds and starts the gateway, funds fresh
accounts via friendbot, and drives the HTTP + on-chain flow. Evidence with
**full (untruncated) transaction hashes** is written to
`docs/evidence/testnet-journey.json` (committed) and printed as a table;
any unexpected HTTP status fails the run.

| Step                                    | Result           | Evidence (full hashes / addresses)                                                                                 |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fund fresh accounts (friendbot)         | ✅               | issuer `GBS36HW…V7WQB`, payer `GAHH47…55S4A`, receiver `GAWCBK…3NAIM`                                              |
| Payer trustline (`USDC:journey issuer`) | ✅               | `03200f89e60f2e39f2baff0586ea3d09aa2ba45cf68d5298124de46e85c2926f`                                                 |
| Receiver trustline                      | ✅               | `7e0fab2e08c9770f39a45f059674f7be757d111d8900050945ee577419d4240a`                                                 |
| Mint 100 USDC → payer                   | ✅               | `8cd5ca6f59af641286fce6ebf36a593f3702cf0f2254fcf36107f1de501d95a0`                                                 |
| Unpaid request → HTTP 402 + quote       | ✅ (5/5 asserts) | quote amount `1000000` stroops, asset `USDC`, issuer matches; memo `4a550a82569c4cb883d33b50`                      |
| On-chain payment (repo wallet builder)  | ✅               | `de98320e68074d0a97dd63a016195ea2551ac004aabc52f1cea97f3ffe11c100`, ledger **4585952**, 0.1 USDC → provider wallet |
| Retry with `X-Payment-Hash`             | ✅ (4/4 asserts) | HTTP 200 + `X-Payment-Receipt`; `receipt.txHash` matches, `status: confirmed`                                      |
| **Replay same hash**                    | ✅ **402**       | `"This payment has already been used"` — single-use enforcement live                                               |
| **Forged / never-existing hash**        | ✅ **402**       | `"Payment verification failed: …"` — fail-closed                                                                   |
| Final balances                          | ✅               | receiver holds the paid 0.1 USDC (money visibly moved)                                                             |

This closes the previous evidence gap (the §6.1.1 run exercised the
contracts directly; this run exercises the **gateway HTTP + verification +
single-use path** against the live chain). Horizon links for every step are
in the evidence JSON.

### 6.2 Operations

- Health/readiness semantics, RTO/RPO targets, backup/restore and DR
  runbooks: [`OPERATIONS.md`](./OPERATIONS.md).
- Dashboards and alert rules: [`OBSERVABILITY.md`](./OBSERVABILITY.md)
  (+ `docs/dashboards/x402-gateway.json`).
- Apply Prisma migrations explicitly (`pnpm db:migrate`) — never `db:push`
  against a database with real traffic without reviewing the diff.

## Deployed Contract Addresses (Testnet)

| Contract         | Address                                                    |
| ---------------- | ---------------------------------------------------------- |
| payment-verifier | `CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ` |
| credit-escrow    | `CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP` |
| multisig         | `CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA` |

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│   Vercel         │     │   Railway         │
│   Dashboard      │────▶│   Gateway         │
│   (Next.js)      │     │   (NestJS)        │
└──────────────────┘     └───────┬──────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Postgres │ │  Redis   │ │ Stellar  │
              │ (Railway)│ │ (Railway)│ │ Testnet  │
              └──────────┘ └──────────┘ └──────────┘
```
