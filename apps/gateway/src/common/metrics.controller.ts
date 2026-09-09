import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { MetricsService } from './metrics.service';

/**
 * Prometheus metrics scrape endpoint.
 *
 * Served outside the global `api/v1` prefix (like /health) so scrapers can
 * hit /metrics directly without the prefix. Plain-text exposition format as
 * expected by Prometheus/Grafana.
 */
@ApiTags('metrics')
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metricsService: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Prometheus metrics (text exposition format)' })
  async metrics(): Promise<string> {
    return this.metricsService.metrics();
  }
}
