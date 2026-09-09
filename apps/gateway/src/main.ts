import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Express, json } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { MetricsService } from './common/metrics.service';
import { createTraceContextMiddleware } from './common/trace-context.middleware';
import { getConfig, validateEnv } from '@x402/config';
import { logger, enableJsonLogs } from '@x402/logger';

async function bootstrap() {
  // Fail fast if required environment variables are missing
  validateEnv();

  // Structured JSON logs in production for log aggregators
  if (process.env.NODE_ENV === 'production') {
    enableJsonLogs();
  }

  const config = getConfig();
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // we set it explicitly below with a size limit
  });

  // Security headers (CSP, X-Frame-Options, HSTS, nosniff, etc.)
  app.use(helmet());

  // W3C trace context: continue or start a trace, propagate `traceparent` on
  // responses, record an `http.request` span per request. Must run before
  // route handling so controllers can create child spans via req.traceContext.
  app.use(createTraceContextMiddleware(app.get(MetricsService)));

  // Cookie parser — required for reading httpOnly session cookies set by
  // the auth controller and sent automatically by the browser.
  app.use(cookieParser());

  // Body size limit: 1 MB is enough for any reasonable chat completion request
  app.use(json({ limit: '1mb' }));

  // Global prefix — health + metrics endpoints are excluded so load
  // balancers and Prometheus scrapers can hit /health and /metrics directly.
  // Sub-paths need explicit wildcard entries: 'health' alone only matches
  // the exact /health route, not /health/live or /health/ready.
  app.setGlobalPrefix('api/v1', {
    exclude: ['health', 'health/(.*)', 'metrics', 'metrics/(.*)'],
  });

  // CORS
  app.enableCors({
    origin: config.security.corsOrigins,
    credentials: true,
  });

  // Trust the first proxy hop (Cloudflare/NGINX/Railway) so `request.ip`
  // reflects the real client IP — required for IP-based rate limiting.
  // Configure via TRUST_PROXY (e.g. "1", "loopback", or a comma-separated
  // list of proxy IPs). See https://expressjs.com/en/guide/behind-proxies.html
  const trustProxy = config.security.trustProxy;
  const httpServer = app.getHttpAdapter().getInstance() as Express;
  httpServer.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);

  // Hard upper bounds on the HTTP server itself: a client that never finishes
  // sending its request (or its headers) must not hold a connection open
  // indefinitely. The 300s ceiling is well above any legitimate request;
  // streaming LLM responses are unaffected (these limits govern request
  // receipt, not response duration).
  const rawServer = app.getHttpServer() as import('http').Server;
  rawServer.requestTimeout = 300_000;
  rawServer.headersTimeout = 65_000;

  // Global exception filter (consistent error format + Retry-After for 429)
  app.useGlobalFilters(new HttpExceptionFilter());

  // Prometheus request metrics for every route
  app.useGlobalInterceptors(new MetricsInterceptor(app.get(MetricsService)));

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('x402 LLM Gateway')
    .setDescription(
      'Pay-per-request LLM gateway using x402 stablecoin micropayments on Stellar.\n\n' +
        'No API keys — just pay in USDC on Stellar and get access to any LLM endpoint.',
    )
    .setVersion('0.1.0')
    .addTag('x402', 'x402 payment protocol endpoints')
    .addTag('proxy', 'LLM proxy endpoints')
    .addTag('providers', 'Provider management')
    .addTag('payments', 'Payment history and status')
    .addTag('analytics', 'Usage and revenue analytics')
    .addTag('admin', 'Admin operations')
    .addTag('health', 'Health check')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Graceful shutdown: close HTTP server + DB/Redis connections on SIGTERM/SIGINT
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  const publicBase = config.publicBaseUrl || `http://${config.host}:${config.port}`;
  logger.info(`🚀 x402 Gateway running on ${publicBase}`, {
    network: config.stellar.network,
    docs: `${publicBase}/api/docs`,
    health: `${publicBase}/health`,
  });
}

bootstrap();
