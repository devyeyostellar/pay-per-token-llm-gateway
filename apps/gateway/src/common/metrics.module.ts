import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

/**
 * Global metrics module — MetricsService is a singleton shared across all
 * gateway modules; MetricsController serves the Prometheus scrape endpoint.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
