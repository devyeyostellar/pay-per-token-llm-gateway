import { Controller, Get, Param, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { paginationSchema } from '@x402/validation';

@ApiTags('payments')
@Controller('payments')
@UseGuards(RateLimitGuard)
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: "List payments to the authenticated wallet's providers" })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'payerAddress', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(
    @CurrentWallet() wallet: string,
    @Query('providerId') providerId?: string,
    @Query('status') status?: string,
    @Query('payerAddress') payerAddress?: string,
    // Express query params always arrive as strings; paginationSchema coerces
    // them to numbers (and rejects NaN/negative via z.coerce + positive int).
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Validate/clamp pagination — raw query strings (e.g. page=abc, limit=-1)
    // previously reached Prisma as NaN/negative skip/take and 500'd.
    const parsed = paginationSchema.safeParse({
      page: page === '' || page === undefined ? undefined : page,
      limit: limit === '' || limit === undefined ? undefined : limit,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { page: safePage, limit: safeLimit } = parsed.data;
    return this.paymentsService.findAll(
      { providerId, status, payerAddress, page: safePage, limit: safeLimit },
      wallet,
    );
  }

  @Get(':quoteId/status')
  @ApiOperation({ summary: 'Get payment status by quote ID' })
  async getStatus(@Param('quoteId') quoteId: string) {
    const payment = await this.paymentsService.findByQuoteId(quoteId);
    if (!payment) {
      return { quoteId, status: 'not_found' as const };
    }
    return {
      quoteId: payment.quoteId,
      status: payment.status,
      txHash: payment.txHash || null,
      amount: typeof payment.amount === 'bigint' ? payment.amount.toString() : payment.amount,
      asset: payment.asset,
      verifiedAt: payment.verifiedAt,
    };
  }
}
