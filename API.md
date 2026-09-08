# API.md

> Complete HTTP API reference for the x402 LLM Gateway. All endpoints are
> served under the global prefix **`/api/v1`** except `/health*` and
> `/metrics`, which are prefix-excluded for load balancers and scrapers.
> Swagger UI: `GET /api/docs`.
> Last updated: **2026-09-08**.

## 1. Conventions

- **Errors**: `{ status, error, message, details? }`; 429s include
  `Retry-After`.
- **Amounts**: always stroops (1 USDC = 10000000 stroops; 7 decimals).
- **Auth**: protected endpoints accept the `x402-session` httpOnly cookie or
  an `Authorization: Bearer <jwt>` header.
- **Rate limiting**: per-IP sliding window. Unpaid tier
  (`RATE_LIMIT_WINDOW`/`RATE_LIMIT_MAX`, default 10 req / 60 s); paid tier
  (requests carrying a _confirmed_ `X-Payment-Hash`) gets 10× the budget in
  2× the window.

---

## 2. Payment flow (the main path)

### `POST /api/v1/chat/completions` — proxy / LLM access

OpenAI-compatible chat completion. Also matches `/api/v1/v1/chat/completions`
and `/v1/chat/completions` path forms.

**Headers**

| Header           | Required     | Description                                |
| ---------------- | ------------ | ------------------------------------------ |
| `Content-Type`   | yes          | `application/json`                         |
| `X-Payment-Hash` | after paying | 64-char hex tx hash of the Stellar payment |

**Request body** — OpenAI-compatible; validated by zod:

| Field                                                        | Bounds                                  |
| ------------------------------------------------------------ | --------------------------------------- |
| `model`                                                      | non-empty string                        |
| `messages`                                                   | 1–128 messages, `content` ≤ 64 KiB each |
| `max_tokens`                                                 | 1–1,000,000                             |
| `temperature`/`top_p`/`frequency_penalty`/`presence_penalty` | standard ranges                         |
| `stream`                                                     | `true` → SSE                            |
| body size                                                    | ≤ 1 MB                                  |

**Responses**

| Status | Condition                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | Payment verified → LLM response (JSON or SSE). Non-stream responses carry `X-Payment-Receipt`, `X-Actual-Cost`, `X-Tokens-Used`, `X-Paid-Amount`, `X-Surplus` (when non-zero), `X-Request-Trace-Id` |
| `402`  | Payment required / expired quote / replay / debt top-up required (see below)                                                                                                                        |
| `400`  | Invalid body or malformed `X-Payment-Hash`                                                                                                                                                          |
| `404`  | No active route for the model+path                                                                                                                                                                  |
| `429`  | Rate limited                                                                                                                                                                                        |
| `502`  | Upstream LLM failure                                                                                                                                                                                |

**402 body**

```json
{
  "status": 402,
  "message": "Payment Required",
  "quote": {
    "id": "3f2d…-uuid",
    "route": "/v1/chat/completions",
    "pricingModel": "flat",
    "amount": "1000000",
    "asset": "USDC",
    "assetIssuer": "GBBD47IF6…FLA5",
    "paymentAddress": "GA5ZSE…",
    "memo": "3f2d9c…",
    "network": "testnet",
    "issuedAt": 1757347200,
    "expiresAt": 1757347500,
    "statusUrl": "https://gateway/api/v1/payments/<quoteId>/status"
  },
  "instructions": "Payment of 1000000 USDC is required…",
  "docs": "https://gateway/docs/x402"
}
```

A `402` can also mean **replay** (`This payment has already been used`),
**expired quote**, **path payments rejected on this network**, **amount below
deposit**, or **debt top-up required** (amount = deposit + open debt).

---

## 3. x402 protocol endpoints

### `POST /api/v1/x402/verify` — verify a payment for a quote

```json
{ "txHash": "64-hex", "quoteId": "uuid" }
```

Returns a `PaymentVerification` (`verified`, `payerAddress`, `amount`,
`ledger`, `timestamp`, `failureReason?`). Only `pending` quotes can be
verified; already-confirmed quotes are refused (single-use invariant).

### `GET /api/v1/x402/status/:quoteId` — payment status

```json
{ "quoteId": "uuid", "status": "pending|confirmed|…", "txHash": null, "verifiedAt": null }
```

---

## 4. Providers (auth required)

| Method   | Path                    | Notes                                                                                                                                               |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/providers`     | List the authenticated wallet's providers                                                                                                           |
| `GET`    | `/api/v1/providers/:id` | Single provider (owned)                                                                                                                             |
| `POST`   | `/api/v1/providers`     | Create. Body: `{ name, webhookUrl?, webhookSecret?, payoutWalletAddress?, metadata? }`. **Wallet ownership comes from the session, never the body** |
| `PUT`    | `/api/v1/providers/:id` | Update owned provider                                                                                                                               |
| `DELETE` | `/api/v1/providers/:id` | Delete owned provider                                                                                                                               |

`webhookUrl` must be HTTPS and resolve to public IPs (SSRF-guarded);
`webhookSecret` ≥ 16 chars. The API never returns `webhookSecret`.

## 5. Routes (auth required)

| Method   | Path                 | Notes                                                                                                             |
| -------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/routes`     | List owned routes (`?providerId=`)                                                                                |
| `GET`    | `/api/v1/routes/:id` | Single route (owned)                                                                                              |
| `POST`   | `/api/v1/routes`     | `{ providerId, path, upstreamUrl, model, pricingModel, flatPrice?, perTokenPrice?, acceptedAssets?, rateLimit? }` |
| `PUT`    | `/api/v1/routes/:id` | Partial update; upstream URL re-validated on change                                                               |
| `DELETE` | `/api/v1/routes/:id` | Delete owned route                                                                                                |

Pricing validation: `flat` requires `flatPrice`; `per_token` requires
`perTokenPrice`; prices must be non-negative integer stroop strings.
`upstreamUrl` is SSRF-validated (public IP only) at create **and** update.

## 6. Payments (auth required)

| Method | Path                               | Notes                                                                                                                  |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/payments`                 | `?providerId=&status=&payerAddress=&page=&limit=` (limit ≤ 100). Only payments to the authenticated wallet's providers |
| `GET`  | `/api/v1/payments/:quoteId/status` | Public status lookup                                                                                                   |

## 7. Analytics (auth required)

| Method | Path                           | Notes                                                                       |
| ------ | ------------------------------ | --------------------------------------------------------------------------- |
| `GET`  | `/api/v1/analytics/summary`    | Revenue, paid/unpaid counts, top callers/routes (scoped to owned providers) |
| `GET`  | `/api/v1/analytics/timeseries` | `?from=&to=&interval=` bucketed series                                      |
| `GET`  | `/api/v1/analytics/events`     | Recent `AnalyticsEvent` rows                                                |

## 8. Admin (auth required)

| Method | Path                   | Notes                                                                             |
| ------ | ---------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/api/v1/admin/stats`  | Gateway statistics for the authenticated wallet                                   |
| `GET`  | `/api/v1/admin/health` | Authenticated health summary                                                      |
| `GET`  | `/api/v1/admin/audit`  | `?providerId=&page=&limit=&action=&entity=` — audit log scoped to owned providers |

## 9. Auth

| Method   | Path                     | Body / Notes                                                                                                                                                    |
| -------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/auth/challenge` | `{ address }` → `{ challengeId, challenge }` (5 min TTL, single-use)                                                                                            |
| `POST`   | `/api/v1/auth/verify`    | `{ challengeId, address, signature }` (base64 Ed25519 sig of the challenge). Sets the `x402-session` httpOnly cookie and returns `{ verified, address, token }` |
| `GET`    | `/api/v1/auth/session`   | Validates cookie/header token → `{ address, sessionId }`; migrates header auth to cookie                                                                        |
| `DELETE` | `/api/v1/auth/session`   | Logout — destroys the Redis session and clears the cookie                                                                                                       |

## 10. Webhooks

| Method | Path                    | Notes                                                    |
| ------ | ----------------------- | -------------------------------------------------------- |
| `POST` | `/api/v1/webhooks/test` | `{ webhookUrl, payload }` — SSRF-validated test delivery |

Outbound webhooks (`payment_received`, `verification_failed`,
`request_forwarded`) are HMAC-SHA256 signed with the provider's
`webhookSecret` in the `X-x402-Signature` header over the raw JSON body.

## 11. Operational endpoints (no `api/v1` prefix)

| Method | Path            | Notes                                                                                               |
| ------ | --------------- | --------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`       | Liveness — always 200 when the process is up                                                        |
| `GET`  | `/health/live`  | Liveness (alias)                                                                                    |
| `GET`  | `/health/ready` | Readiness — pings Postgres + Redis; **503** with per-dependency `checks` detail when either is down |
| `GET`  | `/metrics`      | Prometheus text exposition (see OBSERVABILITY.md)                                                   |
| `GET`  | `/api/docs`     | Swagger UI                                                                                          |

## 12. SDK quick reference

```ts
const client = new X402Client({
  gatewayUrl: 'https://gateway.example.com',
  network: 'testnet',
  secretKey: 'S…',            // or publicKey + signTransaction
});

await client.call({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] });
const stream = await client.callStream({ model: 'gpt-4', messages: […], stream: true });
```

The SDK handles: 402 → parse quote → build+sign+submit payment → poll Horizon
for confirmation → retry with `X-Payment-Hash` → return response + receipt.
Streaming returns an async generator plus receipt/cost via a trailing SSE
`x402_receipt` event.
