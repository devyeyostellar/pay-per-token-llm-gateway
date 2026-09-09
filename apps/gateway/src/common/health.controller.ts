import { Controller, Get, Inject, HttpStatus, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { getConfig } from '@x402/config';
import { logger } from '@x402/logger';
import type { Response } from 'express';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@x402/database';

/**
 * Health check endpoints for load balancers, monitoring, and deployment
 * verification. Excluded from the global `api/v1` prefix so load balancers
 * can hit `/health*` directly.
 *
 * Liveness  (/health, /health/live): the process is up and serving. Always
 *   answers 200 unless the gateway is dying — used to detect crashes/hangs.
 * Readiness (/health/ready): the gateway can actually serve traffic, i.e.
 *   its hard dependencies (PostgreSQL, Redis) are reachable. Answers 503
 *   with per-dependency detail when a dependency is down, so orchestrators
 *   can stop routing traffic to this instance and restart it.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject('PRISMA') private readonly prisma: PrismaClient,
    @Inject('REDIS') private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness check (process is up)' })
  check() {
    return this.livenessBody();
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness check (process is up)' })
  live() {
    return this.livenessBody();
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness check (dependencies reachable)' })
  async ready(@Res({ passthrough: true }) res: Response) {
    const config = getConfig();

    const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

    // ── PostgreSQL ──────────────────────────────
    const dbStart = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (error) {
      checks.database = {
        status: 'down',
        latencyMs: Date.now() - dbStart,
        error: String(error instanceof Error ? error.message : error),
      };
      logger.error('Readiness: database check failed', { error: checks.database.error });
    }

    // ── Redis ───────────────────────────────────
    const redisStart = Date.now();
    try {
      const pong = await this.redis.ping();
      checks.redis =
        pong === 'PONG'
          ? { status: 'ok', latencyMs: Date.now() - redisStart }
          : { status: 'down', error: `Unexpected PING reply: ${pong}` };
    } catch (error) {
      checks.redis = {
        status: 'down',
        latencyMs: Date.now() - redisStart,
        error: String(error instanceof Error ? error.message : error),
      };
      logger.error('Readiness: Redis check failed', { error: checks.redis.error });
    }

    const ready = checks.database.status === 'ok' && checks.redis.status === 'ok';

    if (!ready) {
      // 503 signals the orchestrator to stop routing traffic here. The body
      // carries per-dependency detail so operators can see what is down.
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: ready ? 'ready' : 'not_ready',
      service: 'x402-gateway',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.nodeEnv,
      network: config.stellar.network,
      checks,
    };
  }

  private livenessBody() {
    const config = getConfig();
    return {
      status: 'ok',
      service: 'x402-gateway',
      version: '0.1.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: config.nodeEnv,
      network: config.stellar.network,
    };
  }
}
