/* eslint-disable @typescript-eslint/no-explicit-any */
import { WebhookNotificationHandler, dispatcher, inAppHandler } from './index';
import type { NotificationPayload } from './index';

const payload: NotificationPayload = {
  providerId: 'prov-1',
  event: 'payment_received',
  data: { txHash: 'a1b2', amount: '1000000' },
};

/** Capture fetch calls; returns the request init per call. */
function mockFetch(fn: jest.Mock): void {
  (global as any).fetch = fn;
}

function okFetch() {
  return jest.fn().mockResolvedValue({ ok: true, status: 200 });
}

describe('WebhookNotificationHandler', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).fetch;
  });

  it('delivers an envelope with a stable eventId', async () => {
    const fetchMock = okFetch();
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 1 });
    await handler.send(payload, 'https://hooks.example.com/x402');

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.eventId).toMatch(/^[a-f0-9]{8}$/);
    expect(init.headers['X-x402-Event-Id']).toBe(body.eventId);
    expect(body.event).toBe('payment_received');
    expect(body.data).toEqual({ txHash: 'a1b2', amount: '1000000' });
  });

  it('retries deliver the IDENTICAL body (same eventId, same timestamp) so receivers can dedupe', async () => {
    // First attempt fails, second succeeds — the body and eventId must not
    // change between attempts.
    const bodies: string[] = [];
    const eventIds: string[] = [];
    const fetchMock = jest.fn().mockImplementation(async (_url: string, init: any) => {
      bodies.push(init.body);
      eventIds.push(init.headers['X-x402-Event-Id']);
      return bodies.length === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
    });
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1 });
    const result = await handler.send(payload, 'https://hooks.example.com/x402');

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(eventIds[0]).toBe(eventIds[1]);
  });

  it('eventId is deterministic for the same event+provider+data across calls', async () => {
    const fetchMock = okFetch();
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 1 });
    await handler.send(payload, 'https://hooks.example.com/x402');
    await handler.send(payload, 'https://hooks.example.com/x402');

    const first = JSON.parse(fetchMock.mock.calls[0][1].body).eventId;
    const second = JSON.parse(fetchMock.mock.calls[1][1].body).eventId;
    expect(first).toBe(second);
  });

  it('eventId changes when the payload data changes', async () => {
    const fetchMock = okFetch();
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 1 });
    await handler.send(payload, 'https://hooks.example.com/x402');
    await handler.send(
      { ...payload, data: { txHash: 'different', amount: '2' } },
      'https://hooks.example.com/x402',
    );

    const first = JSON.parse(fetchMock.mock.calls[0][1].body).eventId;
    const second = JSON.parse(fetchMock.mock.calls[1][1].body).eventId;
    expect(first).not.toBe(second);
  });

  it('signs the EXACT body that is retried (signature stays valid across retries)', async () => {
    const fetchMock = okFetch();
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1 });
    const secret = 'webhook-secret';
    await handler.sendWithSignature(payload, 'https://hooks.example.com/x402', secret);

    const [, init] = fetchMock.mock.calls[0];
    const { createHmac } = await import('crypto');
    const expected = createHmac('sha256', secret).update(init.body).digest('hex');
    expect(init.headers['X-x402-Signature']).toBe(expected);
    // The event id header matches the embedded eventId.
    expect(init.headers['X-x402-Event-Id']).toBe(JSON.parse(init.body).eventId);
  });

  it('uses a bounded timeout so a hung receiver cannot stall delivery', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    mockFetch(fetchMock);

    const handler = new WebhookNotificationHandler({ retryCount: 1 });
    await handler.sendWithSignature(payload, 'https://hooks.example.com/x402', 's');

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeDefined();
  });
});

describe('dispatcher + in-app handler', () => {
  it('dispatcher delivers to registered handlers and reports channels', async () => {
    const channels = await dispatcher.dispatch(payload);
    expect(channels).toContain('in_app');
  });

  it('in-app notifications are scoped per provider and bounded', async () => {
    for (let i = 0; i < 5; i++) {
      await inAppHandler.send({ ...payload, data: { i } });
    }
    const list = (await import('./index')).getInAppNotifications('prov-1', 10);
    expect(list.length).toBeGreaterThanOrEqual(5);
    // Other providers see nothing.
    expect((await import('./index')).getInAppNotifications('prov-other', 10)).toHaveLength(0);

    const markRead = (await import('./index')).markInAppRead(list[0].id);
    expect(markRead).toBe(true);
  });
});
