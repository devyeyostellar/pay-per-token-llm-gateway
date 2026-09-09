/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { createTraceContextMiddleware, childSpan } from './trace-context.middleware';
import {
  parseTraceparent,
  serializeTraceparent,
  generateTraceId,
  generateSpanId,
} from '@x402/logger';

function makeReq(headers: Record<string, string> = {}): any {
  return {
    method: 'POST',
    path: '/api/v1/chat/completions',
    headers,
  };
}

function makeRes(): any {
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  res.on = jest.fn((event: string, cb: () => void) => {
    if (event === 'finish') res._finishCb = cb;
  });
  return res;
}

describe('trace-context middleware', () => {
  it('starts a fresh trace when no traceparent header is present', () => {
    const middleware = createTraceContextMiddleware();
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.traceContext).toBeDefined();
    expect(req.traceContext!.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(req.traceContext!.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(req.traceContext!.parentSpanId).toBe('');

    const traceparent = res.headers.traceparent;
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    expect(traceparent).toContain(req.traceContext!.traceId);
    expect(res.headers['X-Request-Trace-Id']).toBe(req.traceContext!.traceId);
  });

  it('continues a valid incoming trace and sets the sampled flag', () => {
    const incoming = `00-${generateTraceId()}-${generateSpanId()}-01`;
    const middleware = createTraceContextMiddleware();
    const req = makeReq({ traceparent: incoming });
    const res = makeRes();

    middleware(req, res, jest.fn());

    expect(req.traceContext!.traceId).toBe(incoming.split('-')[1]);
    // The response traceparent continues the same trace id.
    expect(res.headers.traceparent.startsWith(`00-${incoming.split('-')[1]}-`)).toBe(true);
    expect(res.headers.traceparent.endsWith('-01')).toBe(true);
  });

  it('ignores malformed traceparent headers and starts a fresh trace', () => {
    for (const bad of [
      'not-a-traceparent',
      '01-abc-123-01', // bad version + short ids
      `00-${'z'.repeat(32)}-${'0'.repeat(16)}-01`, // non-hex trace id
      `00-${'0'.repeat(32)}-${'0'.repeat(15)}-01`, // short span id
      `00-${'0'.repeat(32)}-${'0'.repeat(16)}`, // missing flags
    ]) {
      const req = makeReq({ traceparent: bad });
      const res = makeRes();
      createTraceContextMiddleware()(req, res, jest.fn());
      expect(req.traceContext).toBeDefined();
      expect(req.traceContext!.traceId).not.toBe('0'.repeat(32));
      expect(res.headers.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
    }
  });

  it('attaches the context for controllers and emits span end on finish', () => {
    const metrics: any = {
      safe: jest.fn((fn: () => void) => fn()),
      spanDuration: { observe: jest.fn() },
    };
    const middleware = createTraceContextMiddleware(metrics);
    const req = makeReq();
    const res = makeRes();
    middleware(req, res, jest.fn());

    expect(req.traceContext).toBeDefined();
    res._finishCb();

    expect(metrics.spanDuration.observe).toHaveBeenCalledWith(
      { span: 'http.request' },
      expect.any(Number),
    );
  });

  it('childSpan creates a child context under the request trace', () => {
    const req = makeReq();
    createTraceContextMiddleware()(req, makeRes(), jest.fn());

    const parent = req.traceContext!;
    const span = childSpan('payment.verify', req, { txHash: 'abc' });

    expect(span.context.traceId).toBe(parent.traceId);
    expect(span.context.parentSpanId).toBe(parent.spanId);
    expect(span.context.spanId).not.toBe(parent.spanId);
    span.end({ ok: true });
  });

  it('childSpan falls back to a fresh trace when no context exists', () => {
    const span = childSpan('quote.generate', makeReq() as any);
    expect(span.context.traceId).toMatch(/^[a-f0-9]{32}$/);
    span.end();
  });
});

describe('traceparent utils (re-exported from @x402/logger)', () => {
  it('parse + serialize round-trip a valid header', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const header = `00-${traceId}-${spanId}-00`;
    const parsed = parseTraceparent(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.traceId).toBe(traceId);
    expect(parsed!.spanId).toBe(spanId);

    const out = serializeTraceparent({ ...parsed!, flags: 0 });
    // Serialization always marks the trace sampled (flag 0x01).
    expect(out).toBe(`00-${traceId}-${spanId}-01`);
  });

  it('rejects malformed headers', () => {
    expect(parseTraceparent(undefined)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('00-abc')).toBeNull();
    expect(parseTraceparent('99-00000000000000000000000000000000-0000000000000000-01')).toBeNull();
  });
});
