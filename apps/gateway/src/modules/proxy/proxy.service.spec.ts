import { Test, TestingModule } from '@nestjs/testing';
import { ProxyService } from './proxy.service';
import { MetricsService } from '../../common/metrics.service';
import { loadConfig, setConfig } from '@x402/config';
import type { Response } from 'express';

// Mock DNS so the request-time SSRF re-validation passes for test hostnames
// (the proxy re-resolves upstream hosts before forwarding; api.example.com
// would otherwise fail to resolve and every test would be rejected).
jest.mock('dns/promises', () => ({
  lookup: jest.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

import { lookup } from 'dns/promises';
const mockLookup = lookup as jest.Mock;

describe('ProxyService', () => {
  let service: ProxyService;

  // Snapshot the env-based config once so tests that override it (retries,
  // stream timeout) can always restore it afterwards regardless of test order.
  const baseConfig = loadConfig();

  afterEach(() => {
    setConfig(baseConfig);
    jest.useRealTimers();
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProxyService,
        // ProxyService optionally injects REDIS (circuit breaker falls back
        // to the in-memory implementation when null — which is what these
        // tests exercise).
        { provide: 'REDIS', useValue: null },
        MetricsService,
      ],
    }).compile();

    service = module.get<ProxyService>(ProxyService);
  });

  describe('validateRequest', () => {
    it('accepts valid chat completion request', () => {
      expect(
        service.validateRequest({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      ).toBe(true);
    });

    it('rejects null', () => {
      expect(service.validateRequest(null)).toBe(false);
    });

    it('rejects missing model', () => {
      expect(
        service.validateRequest({
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      ).toBe(false);
    });

    it('rejects empty messages', () => {
      expect(
        service.validateRequest({
          model: 'gpt-4',
          messages: [],
        }),
      ).toBe(false);
    });

    it('rejects non-array messages', () => {
      expect(
        service.validateRequest({
          model: 'gpt-4',
          messages: 'not-an-array',
        }),
      ).toBe(false);
    });
  });

  describe('forwardStreamRequest', () => {
    it('sets SSE headers before streaming', async () => {
      const headers = new Map<string, string>();
      const mockRes = {
        setHeader: (name: string, value: string) => {
          headers.set(name, value);
        },
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        get writableEnded() {
          return false;
        },
      } as unknown as Response;

      const readableStream = new ReadableStream({
        start(controller) {
          const data = `data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n`;
          controller.enqueue(new TextEncoder().encode(data));
          controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: readableStream,
      });

      try {
        await service.forwardStreamRequest(
          { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true },
          'https://api.example.com/v1/chat/completions',
          mockRes,
        );

        expect(headers.get('Content-Type')).toBe('text/event-stream');
        expect(headers.get('Cache-Control')).toBe('no-cache, no-transform');
        expect(headers.get('Connection')).toBe('keep-alive');
        expect(headers.get('X-Accel-Buffering')).toBe('no');
        expect(mockRes.flushHeaders).toHaveBeenCalled();
        expect(mockRes.write).toHaveBeenCalled();
        expect(mockRes.end).toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('handles upstream error response', async () => {
      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        get writableEnded() {
          return false;
        },
      } as unknown as Response;

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        body: null,
      });

      try {
        await expect(
          service.forwardStreamRequest(
            { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true },
            'https://api.example.com/v1/chat/completions',
            mockRes,
          ),
        ).rejects.toThrow('Upstream error: 500');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('handles missing response body', async () => {
      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        get writableEnded() {
          return false;
        },
      } as unknown as Response;

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
      });

      try {
        await expect(
          service.forwardStreamRequest(
            { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true },
            'https://api.example.com/v1/chat/completions',
            mockRes,
          ),
        ).rejects.toThrow('no response body');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('calls onDone callback with token count', async () => {
      let doneTokens: number | undefined;
      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        get writableEnded() {
          return false;
        },
      } as unknown as Response;

      const readableStream = new ReadableStream({
        start(controller) {
          const sseData = [
            `data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hi"}}]}`,
            '',
            `data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{}}],"usage":{"total_tokens":42}}`,
            '',
            `data: [DONE]`,
            '',
            '',
          ].join('\n');
          controller.enqueue(new TextEncoder().encode(sseData));
          controller.close();
        },
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: readableStream,
      });

      try {
        await service.forwardStreamRequest(
          { model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }], stream: true },
          'https://api.example.com/v1/chat/completions',
          mockRes,
          undefined,
          undefined,
          (tokens) => {
            doneTokens = tokens;
          },
        );

        expect(doneTokens).toBe(42);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('forwardRequest', () => {
    const upstreamUrl = 'https://api.example.com/v1/chat/completions';
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const responseBody = {
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-4',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };

    beforeEach(() => {
      // Fail fast without retry backoff sleeps so failure-path tests run quickly
      setConfig({ ...baseConfig, llm: { ...baseConfig.llm, maxRetries: 1 } });
    });

    afterEach(() => {
      // Restore the default public-IP resolution for the other tests
      mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    });

    it('rejects the request when the upstream hostname resolves to a private IP', async () => {
      const originalFetch = global.fetch;
      global.fetch = mockOkFetch();

      // Simulate a DNS rebinding attack: the hostname now resolves to the
      // cloud metadata endpoint. Use a unique hostname so it isn't served
      // from the 60s DNS cache populated by earlier tests.
      const rebindUrl = 'https://rebind.example.com/v1/chat/completions';
      mockLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

      try {
        await expect(service.forwardRequest(request, rebindUrl)).rejects.toThrow(
          'does not resolve to a public IP address',
        );
        // The request must never reach the upstream
        expect(global.fetch).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    function mockOkFetch() {
      return jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => responseBody,
      }) as unknown as typeof fetch;
    }

    it('forwards a request with auth and trace headers and returns the response', async () => {
      const originalFetch = global.fetch;
      global.fetch = mockOkFetch();

      try {
        const { response, responseTime } = await service.forwardRequest(
          request,
          upstreamUrl,
          'sk-test-key',
          'trace-123',
        );

        expect(global.fetch).toHaveBeenCalledWith(
          upstreamUrl,
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
              Authorization: 'Bearer sk-test-key',
              'X-Request-Trace-Id': 'trace-123',
            }),
            body: JSON.stringify(request),
          }),
        );
        expect(response).toEqual(responseBody);
        expect(responseTime).toBeGreaterThanOrEqual(0);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('omits optional auth and trace headers when not provided', async () => {
      const originalFetch = global.fetch;
      global.fetch = mockOkFetch();

      try {
        await service.forwardRequest(request, upstreamUrl);

        const [, init] = (global.fetch as jest.Mock).mock.calls[0];
        expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws an upstream error when the status is not ok', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => 'Bad Gateway',
      }) as unknown as typeof fetch;

      try {
        await expect(service.forwardRequest(request, upstreamUrl)).rejects.toThrow(
          'Upstream error: 502 Bad Gateway',
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('throws when the upstream fetch rejects', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

      try {
        await expect(service.forwardRequest(request, upstreamUrl)).rejects.toThrow('ECONNREFUSED');
      } finally {
        global.fetch = originalFetch;
      }
    });

    describe('circuit breaker', () => {
      // Note: the 5-failure threshold and 30s cooldown mirror the
      // CircuitBreaker class defaults in proxy.service.ts — update these
      // tests if the defaults change.
      it('opens after 5 consecutive failures and fast-fails subsequent requests', async () => {
        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;

        try {
          for (let i = 0; i < 5; i++) {
            await expect(service.forwardRequest(request, upstreamUrl)).rejects.toThrow('boom');
          }

          // Circuit is open — even a healthy upstream is rejected immediately
          global.fetch = mockOkFetch();
          await expect(service.forwardRequest(request, upstreamUrl)).rejects.toThrow(
            'Circuit breaker open',
          );
        } finally {
          global.fetch = originalFetch;
        }
      });

      it('allows a half-open test call after the cooldown and resets on success', async () => {
        jest.useFakeTimers();
        const originalFetch = global.fetch;

        try {
          global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
          for (let i = 0; i < 5; i++) {
            await expect(service.forwardRequest(request, upstreamUrl)).rejects.toThrow('boom');
          }

          // After the cooldown the circuit is half-open: one test call is allowed
          jest.advanceTimersByTime(30_000);

          global.fetch = mockOkFetch();
          const { response } = await service.forwardRequest(request, upstreamUrl);
          expect(response).toEqual(responseBody);

          // Success closed the circuit — the next call is not blocked
          const second = await service.forwardRequest(request, upstreamUrl);
          expect(second.response).toEqual(responseBody);
        } finally {
          global.fetch = originalFetch;
        }
      });
    });
  });

  describe('forwardStreamRequest error handling', () => {
    const upstreamUrl = 'https://api.example.com/v1/chat/completions';
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user' as const, content: 'Hi' }],
      stream: true,
    };

    function makeMockRes() {
      return {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        on: jest.fn(),
        removeListener: jest.fn(),
        get writableEnded() {
          return false;
        },
      } as unknown as Response;
    }

    it('records a failure and writes an error chunk when the upstream stream errors', async () => {
      const mockRes = makeMockRes();
      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'));
          controller.error(new Error('stream reset'));
        },
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: readableStream,
      });

      try {
        await service.forwardStreamRequest(request, upstreamUrl, mockRes);

        expect(mockRes.write).toHaveBeenCalledWith(expect.stringContaining('Stream interrupted'));
        expect(mockRes.end).toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('closes the stream when the safety timeout is reached', async () => {
      jest.useFakeTimers();
      setConfig({ ...loadConfig(), llm: { ...loadConfig().llm, streamTimeout: 100 } });

      const onDone = jest.fn();
      const mockRes = makeMockRes();
      const readableStream = new ReadableStream({
        start() {
          /* upstream hangs — never emits data */
        },
      });

      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: readableStream,
      });

      try {
        const pending = service.forwardStreamRequest(
          request,
          upstreamUrl,
          mockRes,
          undefined,
          undefined,
          onDone,
        );

        await jest.advanceTimersByTimeAsync(100);
        await pending;

        expect(mockRes.end).toHaveBeenCalled();
        expect(onDone).toHaveBeenCalled();
        expect(mockRes.write).not.toHaveBeenCalledWith(
          expect.stringContaining('Stream interrupted'),
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
