import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { dispatcher, WebhookNotificationHandler } from '@x402/notifications';
import { prisma } from '@x402/database';
import { logger } from '@x402/logger';
import type { NotificationEvent } from '@x402/types';

/** SSRF guard: only public HTTPS endpoints may be webhook targets. */
export async function validateWebhookUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid webhook URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS');
  }

  // Resolve the hostname and reject private / loopback / link-local / CGNAT
  // ranges and the cloud metadata IP — a webhook endpoint must never reach
  // internal infrastructure.
  let addresses: string[];
  try {
    addresses = (await lookup(parsed.hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new Error('Webhook hostname could not be resolved');
  }
  if (addresses.length === 0) {
    throw new Error('Webhook hostname could not be resolved');
  }

  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error('Webhook URL must point to a public IP address');
    }
  }

  return url;
}

/** True when `ip` is a routable public address (safe as a webhook target). */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0) return false; // 0.0.0.0/8
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // 127.0.0.0/8
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return false; // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // fc00::/7
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    ) {
      return false; // fe80::/10 link-local
    }
    if (lower.startsWith('::ffff:')) {
      // IPv4-mapped — recurse on the embedded IPv4.
      return isPublicIp(lower.slice('::ffff:'.length));
    }
    return true;
  }
  return false;
}

/** HMAC-SHA256 signature over the raw payload, hex-encoded. */
export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * SSRF guard for upstream LLM URLs configured in routes.
 *
 * Unlike webhooks (HTTPS-only), upstream URLs may use HTTP (many LLM APIs
 * and internal proxies run over plain HTTP). The guard still enforces that
 * the resolved hostname points to a public IP address — internal/private
 * infrastructure must never be reachable through the proxy.
 *
 * DNS resolution is performed at configuration time. Runtime re-validation
 * (at proxy time) would add per-request latency; the trust model assumes
 * only authenticated provider wallets can configure routes.
 */
export async function validateUpstreamUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid upstream URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Upstream URL must use HTTP or HTTPS');
  }

  // Resolve the hostname and reject private / loopback / link-local / CGNAT
  // ranges and the cloud metadata IP.
  let addresses: string[];
  try {
    addresses = (await lookup(parsed.hostname, { all: true })).map((a) => a.address);
  } catch {
    throw new Error('Upstream hostname could not be resolved');
  }
  if (addresses.length === 0) {
    throw new Error('Upstream hostname could not be resolved');
  }

  for (const addr of addresses) {
    if (!isPublicIp(addr)) {
      throw new Error('Upstream URL must point to a public IP address');
    }
  }

  return url;
}

@Injectable()
export class WebhooksService {
  /**
   * Dispatch a notification to all registered channels for a provider.
   * Also delivers a signed webhook when the provider configured a webhookUrl.
   */
  async notify(providerId: string, event: NotificationEvent, data: Record<string, unknown>) {
    const channels: string[] = [];

    try {
      const delivered = await dispatcher.dispatch({ providerId, event, data });
      channels.push(...delivered);
    } catch (error) {
      logger.error('Notification dispatch failed', { providerId, event, error: String(error) });
    }

    // Real webhook delivery to the provider's configured endpoint.
    try {
      const provider = await prisma.provider.findUnique({
        where: { id: providerId },
        select: { webhookUrl: true, webhookSecret: true },
      });
      const webhookUrl = provider?.webhookUrl;
      if (webhookUrl) {
        // Re-validate at delivery time: DNS answers can change between save
        // and send (DNS-rebinding TOCTOU), so the SSRF guard must be applied
        // here too — not only when the URL was configured.
        await validateWebhookUrl(webhookUrl);
        const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1000 });
        const ok = await handler.sendWithSignature(
          { providerId, event, data },
          webhookUrl,
          provider?.webhookSecret || undefined,
        );
        if (ok) channels.push('webhook');
      }
    } catch (error) {
      logger.error('Provider webhook delivery failed', { providerId, event, error: String(error) });
    }

    logger.info('Notification dispatched', { providerId, event, channels });
    return { success: channels.length > 0, channels };
  }

  /**
   * Send a payment received notification.
   */
  async notifyPaymentReceived(
    providerId: string,
    data: { txHash: string; amount: string; asset: string; payerAddress: string },
  ) {
    return this.notify(providerId, 'payment_received', data);
  }

  /**
   * Send a verification failure notification.
   */
  async notifyVerificationFailed(providerId: string, data: { txHash: string; reason: string }) {
    return this.notify(providerId, 'verification_failed', data);
  }

  /**
   * Send a test webhook. Validates the target URL against SSRF first.
   */
  async sendWebhook(webhookUrl: string, payload: Record<string, unknown>): Promise<boolean> {
    const validated = await validateWebhookUrl(webhookUrl);
    const { WebhookNotificationHandler } = await import('@x402/notifications');
    const handler = new WebhookNotificationHandler({ retryCount: 3, retryDelayMs: 1000 });
    return handler.send(
      {
        providerId: 'system',
        event: 'request_forwarded',
        data: payload,
      },
      validated,
    );
  }
}
