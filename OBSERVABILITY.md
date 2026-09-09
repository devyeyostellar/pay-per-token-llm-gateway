# OBSERVABILITY.md

> Observability for the x402 LLM Gateway: structured logs, Prometheus metrics,
> trace IDs, dashboards, and actionable alerts. The gateway exposes everything
> a Prometheus/Grafana stack needs at `GET /metrics`; the dashboard JSON in
> §5 is ready to import.
> Last updated: **2026-09-08**.

## 1. Logging

`@x402/logger` emits structured JSON in production (`NODE_ENV=production`
switches to JSON) with fields safe for aggregators (Datadog, Loki, ELK):

```json
{
  "level": "info",
  "ts": "2026-09-08T12:00:00.000Z",
  "msg": "Payment verified successfully",
  "txHash": "ab12…",
  "quoteId": "…",
  "traceId": "…"
}
```

Key log events (all carry `traceId` on the proxy path):

| Event                                         | Level      | Fields                                        |
| --------------------------------------------- | ---------- | --------------------------------------------- |
| Quote generated                               | info       | quoteId, route, providerAddress, pricingModel |
| 402 issued                                    | info       | traceId, model, estimatedTokens               |
| Payment verification started/failed/succeeded | info/warn  | txHash, quoteId, failureReason                |
| Payment replay attempt                        | warn       | txHash, routeId (cross-route vs same-route)   |
| Debt denied / settled / recorded              | warn/info  | payer, providerId, amounts                    |
| Upstream retry / failure / circuit open       | warn/error | hostname, attempts                            |
| Stream timeout / interruption                 | warn/error | model, traceId                                |
| On-chain record / escrow settlement failure   | warn/error | txHash, error                                 |

**Secrets policy:** secrets (`apiKey`, `adminSecret`, `jwtSecret`,
`webhookSecret`) are never logged; `maskSensitive()` masks API keys in any
accidental path.

## 2. Metrics catalog (`GET /metrics`)

Prefix excluded from `api/v1`. `service="x402-gateway"` default label plus:

### 2.1 HTTP (all routes)

| Metric                     | Type      | Labels                | Meaning                     |
| -------------------------- | --------- | --------------------- | --------------------------- |
| `http_requests_total`      | counter   | route, method, status | Request count               |
| `http_request_duration_ms` | histogram | route, method         | Latency (buckets 5 ms–30 s) |

### 2.2 Payment pipeline

| Metric                                   | Type    | Labels        | Meaning                                                       |
| ---------------------------------------- | ------- | ------------- | ------------------------------------------------------------- |
| `x402_quotes_generated_total`            | counter | pricing_model | 402 quotes issued                                             |
| `x402_payments_verified_total`           | counter | asset         | Verified on-chain payments                                    |
| `x402_payment_verification_failed_total` | counter | reason        | Failures (replay, expired, below-deposit, no-match, timeout…) |

### 2.3 Upstream health

| Metric                             | Type    | Labels   | Meaning               |
| ---------------------------------- | ------- | -------- | --------------------- |
| `x402_upstream_failures_total`     | counter | hostname | Failed upstream calls |
| `x402_upstream_retries_total`      | counter | hostname | Retried calls         |
| `x402_circuit_breaker_opens_total` | counter | hostname | Open transitions      |

### 2.4 Revenue & operations

| Metric                                   | Type    | Labels | Meaning                                       |
| ---------------------------------------- | ------- | ------ | --------------------------------------------- |
| `x402_underpayment_debts_recorded_total` | counter | —      | Debt ledger entries                           |
| `x402_onchain_record_failures_total`     | counter | —      | Best-effort on-chain audit writes that failed |

Plus default Node.js metrics: `process_cpu_seconds_total`,
`nodejs_heap_size_total_bytes`, `nodejs_eventloop_lag_seconds`, `nodejs_active_handles`, etc.

## 3. Tracing

No distributed-trace backend is wired; the gateway propagates
`X-Request-Trace-Id` (UUID) through the whole request path (402, verification,
forwarding, audit log, upstream `X-Request-Trace-Id` header). Correlation
across logs/DB rows is by traceId. OpenTelemetry instrumentation is a
tracked enhancement (see §6).

## 4. Alerting rules (Prometheus)

```yaml
groups:
  - name: x402-gateway
    rules:
      # A1 — payment verification is failing en masse (Horizon/RPC issue)
      - alert: PaymentVerificationFailuresHigh
        expr: rate(x402_payment_verification_failed_total[5m]) > 5
        for: 10m
        labels: { severity: page }
        annotations:
          summary: 'Payment verification failures rising ({{ $value }}/5m)'

      # A2 — upstream provider is failing (circuit open / error rate)
      - alert: UpstreamErrorRateHigh
        expr: |
          sum by (hostname) (
            rate(x402_upstream_failures_total[5m])
          ) > 0.5
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: 'Upstream {{ $labels.hostname }} failing'

      # A3 — circuit breaker repeatedly opening (provider outage)
      - alert: CircuitBreakerOpen
        expr: rate(x402_circuit_breaker_opens_total[15m]) > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: 'Circuit breaker opened for {{ $labels.hostname }}'

      # A4 — on-chain audit trail is silently failing (admin key XLM?)
      - alert: OnChainRecordFailures
        expr: rate(x402_onchain_record_failures_total[15m]) > 0
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: 'On-chain payment recording failing — check Soroban RPC + admin key balance'

      # A5 — proxy 5xx (Horizon down / circuit open / upstream down)
      - alert: Gateway5xxHigh
        expr: |
          sum by (route) (
            rate(http_requests_total{status=~"5.."}[5m])
          ) > 2
        for: 10m
        labels: { severity: page }
        annotations:
          summary: 'Gateway 5xx on {{ $labels.route }}'

      # A6 — latency regression
      - alert: ProxyLatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(http_request_duration_ms_bucket{route="/api/v1/chat/completions"}[5m]))
          ) > 5000
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: 'p95 proxy latency > 5s'

      # A7 — readiness failing (orchestrator restart / drain)
      - alert: GatewayNotReady
        expr: probe_success{job="gateway-readiness"} == 0
        for: 5m
        labels: { severity: page }
        annotations:
          summary: 'Gateway /health/ready failing (DB or Redis down)'
```

**SLO suggestion:** payment-verification success rate ≥ 99.5% (30 d), proxy
p95 latency ≤ 5 s, availability ≥ 99.9% (readiness-based).

## 5. Grafana dashboard

`docs/dashboards/x402-gateway.json` (see repo) — a single dashboard with
panels: request rate & latency (p50/p95/p99) by route, payment verification
rate + failure reasons, quote rate by pricing model, upstream error rate +
circuit opens, debt entries, on-chain record failures, and Node heap/event
loop. Import via Grafana → Dashboards → Import.

## 6. Tracked enhancements

- OpenTelemetry SDK + collector export for end-to-end distributed traces.
- Request-log middleware recording every request (status, latency, IP) for
  forensics (currently only key events are logged).
- Structured audit-log stream to an append-only store (S3/object storage) for
  long-term retention (RPO table in [`OPERATIONS.md`](./OPERATIONS.md)).
