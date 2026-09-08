/* eslint-disable @typescript-eslint/no-explicit-any */
import { HealthController } from './health.controller';

function makeController(
  opts: {
    dbOk?: boolean;
    redisOk?: boolean;
  } = {},
) {
  const { dbOk = true, redisOk = true } = opts;
  const prisma = {
    $queryRaw: jest.fn().mockImplementation(async () => {
      if (!dbOk) throw new Error('connection refused');
      return [{ '?column?': 1 }];
    }),
  };
  const redis = {
    ping: jest.fn().mockImplementation(async () => {
      if (!redisOk) throw new Error('ECONNREFUSED');
      return 'PONG';
    }),
  };
  const controller = new HealthController(prisma as any, redis as any);
  return { controller, prisma, redis };
}

describe('HealthController', () => {
  it('liveness returns ok with service metadata', () => {
    const { controller } = makeController();
    const body = controller.check();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('x402-gateway');
    expect(body.timestamp).toBeDefined();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('/health/live is equivalent to liveness', () => {
    const { controller } = makeController();
    expect(controller.live().status).toBe('ok');
  });

  it('readiness reports ready when database and Redis are healthy', async () => {
    const { controller, prisma, redis } = makeController();
    const res = { status: jest.fn() };
    const body = await controller.ready(res as any);

    expect(body.status).toBe('ready');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.redis.status).toBe('ok');
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(redis.ping).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('readiness reports not_ready + 503 when the database is down', async () => {
    const { controller } = makeController({ dbOk: false });
    const res = { status: jest.fn() };
    const body = await controller.ready(res as any);

    expect(body.status).toBe('not_ready');
    expect(body.checks.database.status).toBe('down');
    expect(body.checks.database.error).toContain('connection refused');
    expect(body.checks.redis.status).toBe('ok');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('readiness reports not_ready + 503 when Redis is down', async () => {
    const { controller } = makeController({ redisOk: false });
    const res = { status: jest.fn() };
    const body = await controller.ready(res as any);

    expect(body.status).toBe('not_ready');
    expect(body.checks.redis.status).toBe('down');
    expect(body.checks.database.status).toBe('ok');
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('readiness reports not_ready when both dependencies are down', async () => {
    const { controller } = makeController({ dbOk: false, redisOk: false });
    const res = { status: jest.fn() };
    const body = await controller.ready(res as any);

    expect(body.status).toBe('not_ready');
    expect(body.checks.database.status).toBe('down');
    expect(body.checks.redis.status).toBe('down');
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
