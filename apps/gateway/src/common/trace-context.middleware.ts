import type { Request, Response, NextFunction } from 'express';
import {
  startSpan,
  parseTraceparent,
  serializeTraceparent,
  generateTraceId,
  type TraceContext,
} from '@x402/logger';
import type { MetricsService } from './metrics.service';

/**
 * Express request with the trace context attached by the middleware.
 * Controllers read `req.traceContext` to create child spans.
 */
export interface TraceRequest extends Request {
  traceContext?: TraceContext;
}

/**
 * W3C trace-context middleware.
 *
 * - Accepts an incoming `traceparent` header (validated strictly — a
 *   malformed value is ignored and a fresh trace is started, never trusted).
 * - Attaches the context to `req.traceContext` for child spans.
 * - Propagates the context downstream via the response `traceparent` header
 *   (and the legacy `X-Request-Trace-Id` header) so correlated tooling can
 *   follow the request across gateway instances and upstreams.
 * - Records one `http.request` span per request: structured `span_start` /
 *   `span_end` log events (with duration_ms) plus the
 *   `x402_span_duration_ms` Prometheus histogram.
 */
export function createTraceContextMiddleware(metrics?: MetricsService) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = parseTraceparent(req.headers['traceparent'] as string | undefined);
    const traceId = incoming?.traceId ?? generateTraceId();
    const parentSpanId = incoming?.spanId ?? '';

    const span = startSpan({
      name: 'http.request',
      traceId,
      parentSpanId,
      attributes: { method: req.method, path: req.path },
    });

    (req as TraceRequest).traceContext = {
      traceId,
      spanId: span.context.spanId,
      parentSpanId,
      flags: 1,
    };

    res.setHeader('traceparent', serializeTraceparent(span.context));
    res.setHeader('X-Request-Trace-Id', traceId);

    const startedAt = Date.now();
    res.on('finish', () => {
      span.end({ method: req.method, path: req.path, status: res.statusCode });
      metrics?.safe(() =>
        metrics.spanDuration.observe({ span: 'http.request' }, Date.now() - startedAt),
      );
    });

    next();
  };
}

/**
 * Convenience helper for controllers: create a child span under the request
 * context. Falls back to a fresh trace id when no context is present (e.g.
 * unit tests that bypass the middleware).
 */
export function childSpan(name: string, req: TraceRequest, attributes?: Record<string, unknown>) {
  const ctx = req.traceContext;
  return startSpan({
    name,
    traceId: ctx?.traceId ?? generateTraceId(),
    parentSpanId: ctx?.spanId ?? '',
    attributes,
  });
}
