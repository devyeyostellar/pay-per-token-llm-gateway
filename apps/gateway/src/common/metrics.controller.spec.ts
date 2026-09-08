import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  it('serves the Prometheus text exposition format', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    // Exercise a few instrumented paths so the registry has real data.
    service.safe(() => service.quotesGenerated.inc({ pricing_model: 'flat' }));
    service.safe(() => service.paymentsVerified.inc({ asset: 'USDC' }));
    service.safe(() => service.paymentVerificationFailed.inc({ reason: 'timeout' }));
    service.safe(() =>
      service.httpRequests.inc({ route: '/health', method: 'GET', status: '200' }),
    );

    const out = await controller.metrics();

    expect(out).toContain('# HELP x402_quotes_generated_total');
    // prom-client sorts labels alphabetically and appends the default
    // `service` label: service comes after pricing_model here.
    expect(out).toContain(
      'x402_quotes_generated_total{pricing_model="flat",service="x402-gateway"} 1',
    );
    expect(out).toContain('x402_payments_verified_total{asset="USDC",service="x402-gateway"} 1');
    expect(out).toContain(
      'x402_payment_verification_failed_total{reason="timeout",service="x402-gateway"} 1',
    );
    expect(out).toContain('http_requests_total');
    // Default Node.js metrics are registered too.
    expect(out).toContain('process_cpu_seconds_total');
  });

  it('never throws when a metric increment fails (safe wrapper)', () => {
    const service = new MetricsService();
    expect(() =>
      service.safe(() => {
        throw new Error('boom');
      }),
    ).not.toThrow();
  });

  it('exposes request duration histograms', async () => {
    const service = new MetricsService();
    const controller = new MetricsController(service);

    await service.timed('/api/v1/chat/completions', 'POST', async () => {
      await new Promise((r) => setTimeout(r, 1));
    });

    const out = await controller.metrics();
    expect(out).toContain('http_request_duration_ms_bucket');
  });
});
