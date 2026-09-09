import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiBody } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentWallet } from '../auth/current-wallet.decorator';
import { paginationSchema } from '@x402/validation';

@ApiTags('admin')
@Controller('admin')
@UseGuards(AuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check (authenticated)' })
  async health() {
    return this.adminService.getHealth();
  }

  @Get('stats')
  @ApiOperation({ summary: 'Gateway statistics scoped to the authenticated wallet' })
  async stats(@CurrentWallet() wallet: string) {
    return this.adminService.getStats(wallet);
  }

  @Get('payouts')
  @ApiOperation({ summary: "List payout proposals for the authenticated wallet's providers" })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async payouts(
    @CurrentWallet() wallet: string,
    @Query('providerId') providerId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = paginationSchema.safeParse({
      page: page === '' || page === undefined ? undefined : page,
      limit: limit === '' || limit === undefined ? undefined : limit,
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const { page: safePage, limit: safeLimit } = parsed.data;
    return this.adminService.listPayouts(wallet, {
      providerId,
      status,
      page: safePage,
      limit: safeLimit,
    });
  }

  @Post('payouts/propose')
  @ApiOperation({ summary: 'Propose a provider payout through the multisig contract' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['providerId'],
      properties: {
        providerId: { type: 'string', description: 'Provider id owned by the caller' },
        amount: {
          type: 'string',
          description:
            'Optional payout amount in stroops. Defaults to all pending confirmed revenue.',
        },
      },
    },
  })
  async proposePayout(
    @CurrentWallet() wallet: string,
    @Body() body: { providerId?: string; amount?: string },
  ) {
    if (!body.providerId) {
      throw new BadRequestException('providerId is required');
    }
    return this.adminService.proposePayout(wallet, {
      providerId: body.providerId,
      amount: body.amount,
    });
  }

  @Post('payouts/:id/approve')
  @ApiOperation({ summary: 'Approve a payout proposal as a multisig signer' })
  async approvePayout(@CurrentWallet() wallet: string, @Param('id') id: string) {
    return this.adminService.approvePayout(wallet, id);
  }

  @Get('audit')
  @ApiOperation({ summary: "Get audit logs for the authenticated wallet's providers" })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entity', required: false })
  async auditLogs(
    @CurrentWallet() wallet: string,
    @Query('providerId') providerId?: string,
    // Express query params always arrive as strings; paginationSchema coerces
    // them to numbers (and rejects NaN/negative via z.coerce + positive int).
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
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
    return this.adminService.getAuditLogs(wallet, {
      providerId,
      page: safePage,
      limit: safeLimit,
      action,
      entity,
    });
  }
}
