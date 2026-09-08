import { Injectable, Logger } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/**
 * Central Prometheus metrics registry for the gateway.
 *
 * Exposes default Node.js/process metrics (event-loop lag, heap, handles)
 * plus gateway-domain counters/histograms that feed dashboards and alerts:
 *
 *   - http_requests_total / http_request_duration_ms  (per route + status)
 *   - x402_quotes_generated_total                      (per pricing model)
 *   - x402_payments_verified_total / _failed_total     (per asset / reason)
 *   - x402_upstream_failures_total / _retries_total    (per hostname)
 *   - x402_circuit_breaker_opens_total                 (per hostname)
 *   - x402_underpayment_debts_recorded_total
 *   - x402_onchain_record_failures_total
 *
 * All instrumented call sites are wrapped so a metrics failure can never
 * affect the request path. The registry is scraped by Prometheus via
 * GET /metrics (see MetricsController).
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry: Registry;

  readonly httpRequests: Counter<string>;
  readonly httpRequestDuration: Histogram<string>;
  readonly quotesGenerated: Counter<string>;
  readonly paymentsVerified: Counter<string>;
  readonly paymentVerificationFailed: Counter<string>;
  readonly upstreamFailures: Counter<string>;
  readonly upstreamRetries: Counter<string>;
  readonly circuitBreakerOpens: Counter<string>;
  readonly underpaymentDebtsRecorded: Counter<string>;
  readonly onChainRecordFailures: Counter<string>;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: 'x402-gateway' });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests served',
      labelNames: ['route', 'method', 'status'] as const,
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['route', 'method'] as const,
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
      registers: [this.registry],
    });

    this.quotesGenerated = new Counter({
      name: 'x402_quotes_generated_total',
      help: 'Payment quotes issued',
      labelNames: ['pricing_model'] as const,
      registers: [this.registry],
    });

    this.paymentsVerified = new Counter({
      name: 'x402_payments_verified_total',
      help: 'On-chain payments verified',
      labelNames: ['asset'] as const,
      registers: [this.registry],
    });

    this.paymentVerificationFailed = new Counter({
      name: 'x402_payment_verification_failed_total',
      help: 'Payment verifications that failed',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.upstreamFailures = new Counter({
      name: 'x402_upstream_failures_total',
      help: 'Upstream LLM request failures',
      labelNames: ['hostname'] as const,
      registers: [this.registry],
    });

    this.upstreamRetries = new Counter({
      name: 'x402_upstream_retries_total',
      help: 'Upstream LLM request retries',
      labelNames: ['hostname'] as const,
      registers: [this.registry],
    });

    this.circuitBreakerOpens = new Counter({
      name: 'x402_circuit_breaker_opens_total',
      help: 'Circuit breaker transitions to open',
      labelNames: ['hostname'] as const,
      registers: [this.registry],
    });

    this.underpaymentDebtsRecorded = new Counter({
      name: 'x402_underpayment_debts_recorded_total',
      help: 'Underpayment debt ledger entries recorded',
      registers: [this.registry],
    });

    this.onChainRecordFailures = new Counter({
      name: 'x402_onchain_record_failures_total',
      help: 'Best-effort on-chain payment records that failed',
      registers: [this.registry],
    });

    // Node.js runtime metrics: event-loop lag, heap usage, handles, etc.
    collectDefaultMetrics({ register: this.registry });
  }

  /** Render the registry in Prometheus text exposition format. */
  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  /** Safe wrapper around a metric increment — never throws into the request path. */
  safe(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn('Metric increment failed', { error: String(error) });
    }
  }

  /** Time an async operation and record its duration histogram. */
  async timed<T>(route: string, method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.safe(() => this.httpRequestDuration.observe({ route, method }, Date.now() - start));
    }
  }
}
