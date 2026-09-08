import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import type { MetricsService } from './metrics.service';

/**
 * Global interceptor that records one `http_requests_total` increment and one
 * `http_request_duration_ms` observation per HTTP request. Registered in
 * main.ts with the singleton MetricsService.
 *
 * The `route` label uses the Express route pattern when available
 * (e.g. `/api/v1/chat/completions`) so label cardinality stays bounded
 * regardless of how many distinct quote IDs / tx hashes flow through.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const start = Date.now();
    const route = req.route?.path || req.path || 'unknown';
    const method = req.method || 'UNKNOWN';

    return next.handle().pipe(
      tap({
        next: () => this.record(route, method, res.statusCode, start),
        error: () => this.record(route, method, res.statusCode || 500, start),
      }),
    );
  }

  private record(route: string, method: string, status: number, start: number): void {
    this.metrics.safe(() => {
      this.metrics.httpRequests.inc({ route, method, status: String(status) });
      this.metrics.httpRequestDuration.observe({ route, method }, Date.now() - start);
    });
  }
}
