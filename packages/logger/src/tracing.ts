// ──────────────────────────────────────────────
// @x402/logger — tracing (W3C trace context)
// ──────────────────────────────────────────────
//
// Dependency-free distributed tracing: W3C `traceparent` header
// parsing/serialization plus a lightweight span recorder that emits
// structured `span_start` / `span_end` log events with durations.
//
// The gateway middleware continues an incoming trace (or starts a new one),
// propagates `traceparent` on responses and upstream calls, and controllers
// create child spans for the quote → verify → forward phases. There is no
// external tracing backend dependency: spans surface in the structured logs
// (and the trace-id correlation story the logger already had), and the
// `x402_span_duration_ms` metric makes them observable in Prometheus.

/** Minimal trace context carried through the request path. */
export interface TraceContext {
  /** 32-char hex trace id (W3C). */
  traceId: string;
  /** 16-char hex span id of the current span (W3C). */
  spanId: string;
  /** 16-char hex id of the parent span (empty for the root span). */
  parentSpanId: string;
  /** Sampling flags byte (0x01 = sampled). */
  flags: number;
}

const HEX = '0123456789abcdef';

/** Random n-char lowercase hex string (crypto-free, sufficient for correlation). */
function randomHex(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

export function generateTraceId(): string {
  return randomHex(32);
}

export function generateSpanId(): string {
  return randomHex(16);
}

/**
 * Parse a W3C `traceparent` header value.
 *
 * Format: `version-traceid-spanid-flags` (e.g. `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`).
 * Returns null for any malformed value — the caller then starts a new trace
 * rather than trusting an attacker-controlled header. Version is not
 * validated beyond `00` (unknown future versions are rejected so we never
 * misinterpret a newer format).
 */
export function parseTraceparent(header: string | undefined | null): TraceContext | null {
  if (!header) return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flagsHex] = parts;
  if (version !== '00') return null;
  if (!/^[a-f0-9]{32}$/i.test(traceId)) return null;
  if (!/^[a-f0-9]{16}$/i.test(spanId)) return null;
  if (!/^[a-f0-9]{2}$/i.test(flagsHex)) return null;
  const flags = parseInt(flagsHex, 16);
  return { traceId: traceId.toLowerCase(), spanId: spanId.toLowerCase(), parentSpanId: '', flags };
}

/** Serialize a trace context back into a `traceparent` header value. */
export function serializeTraceparent(ctx: TraceContext): string {
  const flags = (ctx.flags & 0x01) | 0x01; // always set the sampled flag
  return `00-${ctx.traceId}-${ctx.spanId}-${flags.toString(16).padStart(2, '0')}`;
}

/** Create a child context for propagation given a parent trace id. */
export function childTraceContext(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    flags: parent.flags,
  };
}

export interface SpanOptions {
  /** Span name (e.g. `quote.generate`, `payment.verify`, `upstream.forward`). */
  name: string;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  attributes?: Record<string, unknown>;
}

export interface Span {
  /** Finish the span; emits a structured `span_end` log with duration_ms. */
  end(attributes?: Record<string, unknown>): void;
  /** The trace context this span created (for propagation downstream). */
  readonly context: TraceContext;
}

/**
 * Start a span. On `end()` a structured log line is emitted:
 *
 *   {"ts":…,"level":"info","msg":"span_end","trace":"<traceId>","span":"<name>",
 *    "span_id":"…","parent_span_id":"…","duration_ms":…}
 *
 * Spans are always ended by the caller (middleware/controllers); a stray
 * span is harmless — it simply never emits its end event.
 */
export function startSpan(options: SpanOptions): Span {
  const spanId = options.spanId ?? generateSpanId();
  const context: TraceContext = {
    traceId: options.traceId,
    spanId,
    parentSpanId: options.parentSpanId ?? '',
    flags: 1,
  };
  const startedAt = Date.now();

  emitSpanEvent('span_start', options.name, context, {
    ...options.attributes,
  });

  return {
    end(attributes) {
      const durationMs = Date.now() - startedAt;
      emitSpanEvent('span_end', options.name, context, {
        duration_ms: durationMs,
        ...attributes,
      });
    },
    get context() {
      return context;
    },
  };
}

function emitSpanEvent(
  event: 'span_start' | 'span_end',
  name: string,
  ctx: TraceContext,
  attributes: Record<string, unknown>,
): void {
  // Route through the structured logger; trace id lands in the `trace` field
  // (same key the logger's trace-id child loggers use).
  const entry = {
    trace: ctx.traceId,
    span: name,
    span_id: ctx.spanId,
    ...(ctx.parentSpanId ? { parent_span_id: ctx.parentSpanId } : {}),
    ...attributes,
  };
  // eslint-disable-next-line no-console
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    msg: event,
    ...entry,
  });
  process.stdout.write(line + '\n');
}
