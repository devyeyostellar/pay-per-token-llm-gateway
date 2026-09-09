import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { AuthModule } from '../auth/auth.module';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, RateLimitGuard],
  exports: [PaymentsService],
})
export class PaymentsModule {}
