import { Global, Module, Logger, OnModuleInit, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { getConfig } from '@x402/config';

const redisProvider = {
  provide: 'REDIS',
  useFactory: () => {
    const config = getConfig();
    return new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      // Bounded retries + connect timeout so a down Redis fails startup
      // (or surfaces a readiness error) instead of hanging forever.
      connectTimeout: 5_000,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 100, 3000)),
      // Connect eagerly so connection failures surface at startup,
      // not at the first request.
      lazyConnect: false,
    });
  },
};

@Global()
@Module({
  providers: [redisProvider],
  exports: ['REDIS'],
})
export class RedisModule implements OnModuleInit {
  private readonly logger = new Logger(RedisModule.name);

  constructor(@Inject('REDIS') private readonly redis: Redis) {}

  async onModuleInit() {
    const config = getConfig();
    const isProduction = config.nodeEnv === 'production';

    try {
      await this.redis.ping();
      this.logger.log('✅ Redis connected');
    } catch (error) {
      const message =
        `Redis connection failed: ${String(error)}. ` +
        (isProduction
          ? 'Redis is REQUIRED in production — the gateway cannot start without it. ' +
            'Check that REDIS_URL is correct and the Redis server is reachable.'
          : 'Start a Redis server (docker compose up -d redis) or set REDIS_URL.');
      this.logger.error(message);
      throw new Error(message);
    }
  }
}
