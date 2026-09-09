import { Injectable, Inject } from '@nestjs/common';
import type { Response } from 'express';
import type { ChatCompletionRequest, ChatCompletionResponse } from '@x402/types';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import { retry, NonRetryableError } from '@x402/shared';
import type { Redis } from 'ioredis';
import { isPublicIp } from '../webhooks/webhooks.service';
import { lookup } from 'dns/promises';
import { MetricsService } from '../../common/metrics.service';

// ── DNS Rebinding Protection ─────────────────

interface DnsCacheEntry {
  ips: string[];
  expiresAt: number;
}

/**
 * DNS resolution cache with 60-second TTL for upstream SSRF re-validation.
 *
 * At route configuration time the upstream URL's hostname is resolved and
 * validated (public IP only). At proxy time, the resolved IPs are re-checked
 * against a short-lived cache to catch DNS rebinding attacks — a provider
 * who controls the domain could rebind it to 169.254.169.254 after config
 * passes the SSRF guard.
 */
const dnsCache = new Map<string, DnsCacheEntry>();
const DNS_CACHE_TTL_MS = 60_000;

async function isUpstreamHostPublic(hostname: string): Promise<boolean> {
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    // Cache hit — re-check all cached IPs against public-IP rules.
    return cached.ips.every((ip) => isPublicIp(ip));
  }

  // Cache miss or expired — re-resolve.
  try {
    const addresses = (await lookup(hostname, { all: true })).map((a) => a.address);
    dnsCache.set(hostname, { ips: addresses, expiresAt: now + DNS_CACHE_TTL_MS });
    return addresses.length > 0 && addresses.every((ip) => isPublicIp(ip));
  } catch {
    // DNS resolution failure at proxy time: reject the request rather
    // than risk connecting to an unknown address.
    logger.warn('Upstream DNS resolution failed at proxy time', { hostname });
    return false;
  }
}

// ── Circuit Breaker ──────────────────────────

interface CircuitState {
  failures: number;
  lastFailureTime: number;
  open: boolean;
}

/**
 * Redis-backed circuit breaker per upstream URL.
 *
 * When a Redis client is available, circuit state is persisted to Redis with
 * proper TTLs so all gateway instances share the same circuit. Falls back to
 * an in-memory Map when Redis is not available (single-instance deployments).
 */
class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();
  private readonly redis: Redis | null;

  private static readonly KEY_PREFIX = 'x402:circuit:';

  constructor(
    redis: Redis | null,
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
    private readonly metrics?: MetricsService,
  ) {
    this.redis = redis;
  }

  private recordOpened(hostname: string): void {
    const metrics = this.metrics;
    if (metrics) metrics.safe(() => metrics.circuitBreakerOpens.inc({ hostname }));
  }

  async checkCircuit(upstreamUrl: string): Promise<void> {
    const hostname = new URL(upstreamUrl).hostname;

    if (this.redis) {
      return this.checkCircuitRedis(hostname);
    }
    return this.checkCircuitMemory(hostname);
  }

  async recordSuccess(upstreamUrl: string): Promise<void> {
    const hostname = new URL(upstreamUrl).hostname;

    if (this.redis) {
      await this.recordSuccessRedis(hostname);
    } else {
      this.recordSuccessMemory(hostname);
    }
  }

  async recordFailure(upstreamUrl: string): Promise<void> {
    const hostname = new URL(upstreamUrl).hostname;

    if (this.redis) {
      await this.recordFailureRedis(hostname);
    } else {
      this.recordFailureMemory(hostname);
    }
  }

  // ── Redis-backed circuit breaker ────────────

  private async checkCircuitRedis(hostname: string): Promise<void> {
    const key = CircuitBreaker.KEY_PREFIX + hostname;
    const redis = this.redis;
    if (!redis) return;

    try {
      // Atomic Lua script: check if circuit is open, allow half-open probe.
      const script = `
        local state = redis.call('GET', KEYS[1] .. ':state')
        if state == 'open' then
          local failures_key = KEYS[1] .. ':failures'
          local last_failure = redis.call('ZREVRANGE', failures_key, 0, 0, 'WITHSCORES')
          if #last_failure > 0 then
            local ts = tonumber(last_failure[2])
            local elapsed = tonumber(ARGV[1]) - ts
            local cooldown = tonumber(ARGV[2])
            if elapsed >= cooldown then
              -- Half-open: allow one probe call
              redis.call('SET', KEYS[1] .. ':state', 'half-open', 'EX', ARGV[3])
              return 'half-open'
            end
            return 'open:' .. math.ceil((cooldown - elapsed) / 1000)
          end
        end
        return 'ok'
      `;

      const result = (await redis.eval(
        script,
        1,
        key,
        String(Date.now()),
        String(this.cooldownMs),
        String(Math.ceil(this.cooldownMs / 1000) + 10),
      )) as string;

      if (result === 'ok' || result === 'half-open') {
        if (result === 'half-open') {
          logger.warn('Circuit half-open — allowing test call', { hostname });
        }
        return;
      }

      const retryIn = result.replace('open:', '');
      throw new Error(`Circuit breaker open for ${hostname}. Retry in ${retryIn}s.`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Circuit breaker open')) {
        throw err;
      }
      // Redis error → fall through (allow the request).
      logger.warn('Circuit breaker Redis check failed, allowing request', {
        hostname,
        error: String(err),
      });
    }
  }

  private async recordSuccessRedis(hostname: string): Promise<void> {
    try {
      const key = CircuitBreaker.KEY_PREFIX + hostname;
      await this.redis?.del(key + ':state', key + ':failures');
    } catch {
      /* best-effort */
    }
  }

  private async recordFailureRedis(hostname: string): Promise<void> {
    const redis = this.redis;
    if (!redis) return;

    try {
      const key = CircuitBreaker.KEY_PREFIX + hostname;
      const failuresKey = key + ':failures';
      const now = Date.now();

      // Add failure timestamp to sorted set + set TTL.
      const script = `
        redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
        redis.call('EXPIRE', KEYS[1], ARGV[3])
        local count = redis.call('ZCARD', KEYS[1])
        if count >= tonumber(ARGV[4]) then
          redis.call('SET', KEYS[2], 'open', 'EX', ARGV[5])
          return 'open'
        end
        return 'closed'
      `;

      const result = (await redis.eval(
        script,
        2,
        failuresKey,
        key + ':state',
        String(now),
        `${now}-${Math.random().toString(36).slice(2, 9)}`,
        String(this.cooldownMs / 1000 + 10),
        String(this.failureThreshold),
        String(Math.ceil(this.cooldownMs / 1000) + 10),
      )) as string;

      if (result === 'open') {
        this.recordOpened(hostname);
        logger.error('Circuit breaker opened (Redis)', {
          hostname,
          failures: this.failureThreshold,
          cooldownMs: this.cooldownMs,
        });
      }
    } catch (err) {
      logger.warn('Circuit breaker Redis failure recording failed', {
        hostname,
        error: String(err),
      });
    }
  }

  // ── In-memory fallback ─────────────────────

  private checkCircuitMemory(hostname: string): void {
    const circuit = this.circuits.get(hostname);
    if (!circuit?.open) return;

    const elapsed = Date.now() - circuit.lastFailureTime;
    if (elapsed >= this.cooldownMs) {
      circuit.open = false;
      logger.warn('Circuit half-open — allowing test call', { upstreamUrl: hostname });
      return;
    }

    const retryIn = Math.ceil((this.cooldownMs - elapsed) / 1000);
    throw new Error(`Circuit breaker open for ${hostname}. Retry in ${retryIn}s.`);
  }

  private recordSuccessMemory(hostname: string): void {
    this.circuits.delete(hostname);
  }

  private recordFailureMemory(hostname: string): void {
    const circuit = this.circuits.get(hostname) || {
      failures: 0,
      lastFailureTime: 0,
      open: false,
    };

    circuit.failures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.failures >= this.failureThreshold) {
      circuit.open = true;
      this.recordOpened(hostname);
      logger.error('Circuit breaker opened', {
        upstreamUrl: hostname,
        failures: circuit.failures,
        cooldownMs: this.cooldownMs,
      });
    }

    this.circuits.set(hostname, circuit);
  }
}

// ── Proxy Service ────────────────────────────

@Injectable()
export class ProxyService {
  private readonly circuitBreaker: CircuitBreaker;

  constructor(
    @Inject('REDIS') redis: Redis | null,
    private readonly metrics: MetricsService,
  ) {
    this.circuitBreaker = new CircuitBreaker(redis, 5, 30_000, metrics);
  }

  /**
   * Forward a request to the upstream LLM endpoint (non-streaming).
   */
  async forwardRequest(
    request: ChatCompletionRequest,
    upstreamUrl: string,
    apiKey?: string,
    traceId?: string,
    traceparent?: string,
  ): Promise<{ response: ChatCompletionResponse; responseTime: number }> {
    const config = getConfig();
    const startTime = Date.now();

    // DNS rebinding guard: re-validate the upstream hostname at proxy time.
    // The URL was already validated at route-config time, but DNS answers
    // can change between save and send (TOCTOU).
    const upstreamHost = new URL(upstreamUrl).hostname;
    if (!(await isUpstreamHostPublic(upstreamHost))) {
      throw new NonRetryableError(
        `Upstream host ${upstreamHost} does not resolve to a public IP address`,
      );
    }

    // Circuit breaker check — fast-fail if the upstream has been failing
    await this.circuitBreaker.checkCircuit(upstreamUrl);

    try {
      const response = await retry(
        async () => {
          const res = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(traceId ? { 'X-Request-Trace-Id': traceId } : {}),
              ...(traceparent ? { traceparent } : {}),
              ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(config.llm.requestTimeout),
          });

          if (!res.ok) {
            const errorBody = await res.text();
            // 4xx errors are client/config errors — retrying them wastes
            // upstream quota and adds latency. Only 5xx/network/timeouts retry.
            if (res.status >= 400 && res.status < 500) {
              throw new NonRetryableError(`Upstream error: ${res.status} ${errorBody}`);
            }
            throw new Error(`Upstream error: ${res.status} ${errorBody}`);
          }

          return res;
        },
        {
          maxAttempts: config.llm.maxRetries,
          baseDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.metrics.safe(() => this.metrics.upstreamRetries.inc({ hostname: upstreamHost }));
            logger.warn(`Retrying upstream call (attempt ${attempt})`, { error: error.message });
          },
        },
      );

      await this.circuitBreaker.recordSuccess(upstreamUrl);

      const data = (await response.json()) as ChatCompletionResponse;
      const responseTime = Date.now() - startTime;

      logger.info('Upstream request completed', {
        model: request.model,
        responseTime,
        tokens: data.usage?.total_tokens,
      });

      return { response: data, responseTime };
    } catch (error) {
      this.metrics.safe(() => this.metrics.upstreamFailures.inc({ hostname: upstreamHost }));
      await this.circuitBreaker.recordFailure(upstreamUrl);
      throw error;
    }
  }

  /**
   * Forward a streaming request to the upstream LLM and pipe SSE chunks
   * directly to the client response. Handles client disconnection gracefully
   * and extracts usage tokens from the final stream chunk.
   *
   * On completion, calls `onDone` with the total token count (if available)
   * BEFORE closing the response stream so the callback can write trailing
   * SSE data (receipt, cost info) while the response is still writable.
   */
  async forwardStreamRequest(
    request: ChatCompletionRequest,
    upstreamUrl: string,
    res: Response,
    apiKey?: string,
    traceId?: string,
    traceparent?: string,
    onDone?: (totalTokens?: number) => void | Promise<void>,
  ): Promise<void> {
    const config = getConfig();
    const startTime = Date.now();

    // DNS rebinding guard (same rationale as forwardRequest).
    const upstreamHost = new URL(upstreamUrl).hostname;
    if (!(await isUpstreamHostPublic(upstreamHost))) {
      throw new NonRetryableError(
        `Upstream host ${upstreamHost} does not resolve to a public IP address`,
      );
    }

    // Circuit breaker check — fast-fail if the upstream has been failing
    await this.circuitBreaker.checkCircuit(upstreamUrl);

    // Use configured streaming timeout (defaults to 10 minutes)
    const streamTimeout = config.llm.streamTimeout ?? 600_000;

    // AbortController for client-disconnect propagation to upstream
    const abortController = new AbortController();

    let upstreamResponse: globalThis.Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(traceId ? { 'X-Request-Trace-Id': traceId } : {}),
          ...(traceparent ? { traceparent } : {}),
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ ...request, stream: true }),
        signal: abortController.signal,
      });
    } catch (err) {
      await this.circuitBreaker.recordFailure(upstreamUrl);
      throw err;
    }

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      await this.circuitBreaker.recordFailure(upstreamUrl);
      throw new Error(`Upstream error: ${upstreamResponse.status} ${errorBody}`);
    }

    await this.circuitBreaker.recordSuccess(upstreamUrl);

    if (!upstreamResponse.body) {
      throw new Error('Upstream returned no response body for streaming');
    }

    // Set SSE headers on the client response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders(); // send headers immediately

    const reader = upstreamResponse.body.getReader();
    let totalTokens: number | undefined;
    let aborted = false;

    // Handle client disconnection → abort upstream fetch + reader
    const onClientClose = () => {
      aborted = true;
      abortController.abort();
      try {
        reader.cancel();
      } catch {
        /* ignore */
      }
    };
    res.on('close', onClientClose);

    // Safety timeout: if upstream hangs, close the stream
    const safetyTimer = setTimeout(() => {
      if (!aborted && !res.writableEnded) {
        logger.warn('Stream timeout reached, closing connection', { model: request.model });
        abortController.abort();
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        onClientClose();
      }
    }, streamTimeout);

    try {
      const decoder = new TextDecoder();
      let lineBuffer = '';

      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        // Forward raw bytes to the client immediately, honoring backpressure.
        // Without this, a slow consumer would make the gateway buffer the
        // entire upstream stream in memory. Node's `res.write` returns false
        // exactly when the socket buffer is full — wait for 'drain' (or the
        // client closing) before reading more. A non-boolean result (e.g. a
        // mock) means the write was accepted and we keep streaming.
        if (res.write(value) === false) {
          await new Promise<void>((resolve) => {
            const cleanup = () => {
              res.removeListener('drain', onDrain);
              res.removeListener('close', onClose);
            };
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              resolve();
            };
            if (typeof res.once === 'function') {
              res.once('drain', onDrain);
              res.once('close', onClose);
            } else {
              // Minimal emitter (test doubles): don't block the stream.
              setImmediate(onDrain);
            }
          });
        }

        // Parse individual SSE lines to extract usage from the last valid chunk
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;

          try {
            const jsonStr = trimmed.slice(6);
            const parsed = JSON.parse(jsonStr);
            // Capture usage from any chunk that has it (typically the last)
            if (parsed.usage?.total_tokens != null) {
              totalTokens = parsed.usage.total_tokens;
            }
          } catch {
            /* skip unparseable lines */
          }
        }
      }
    } catch (err) {
      if (!aborted) {
        await this.circuitBreaker.recordFailure(upstreamUrl);
        logger.error('Stream forwarding error', { error: String(err) });
        if (!res.writableEnded) {
          try {
            res.write(
              `data: ${JSON.stringify({ error: { message: 'Stream interrupted', type: 'gateway_error' } })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
          } catch {
            /* client may have disconnected */
          }
        }
      }
    } finally {
      clearTimeout(safetyTimer);
      reader.releaseLock();
      res.removeListener('close', onClientClose);

      // Call onDone BEFORE closing the stream so the callback can write
      // trailing SSE data (receipt, cost info) while the response is
      // still writable. Must be awaited — otherwise the async writes
      // in the callback would race with res.end() below.
      await onDone?.(totalTokens);

      if (!res.writableEnded) {
        res.end();
      }

      const responseTime = Date.now() - startTime;
      logger.info('Streaming request completed', {
        model: request.model,
        responseTime,
        tokens: totalTokens,
        aborted,
      });
    }
  }

  /**
   * Validate that the incoming request has the expected format.
   */
  validateRequest(request: unknown): request is ChatCompletionRequest {
    if (!request || typeof request !== 'object') return false;
    const r = request as Record<string, unknown>;
    return (
      typeof r.model === 'string' &&
      Array.isArray(r.messages) &&
      (r.messages as unknown[]).length > 0
    );
  }
}
