import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Headers,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { stellarAddressSchema } from '@x402/validation';
import { getConfig } from '@x402/config';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';

@ApiTags('auth')
@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Get a challenge for wallet-based authentication.
   * The client signs this challenge with their Stellar private key
   * and submits the signature to /auth/verify.
   */
  @Post('challenge')
  @ApiOperation({ summary: 'Request an authentication challenge' })
  createChallenge(@Body('address') address: string) {
    const parsed = stellarAddressSchema.safeParse(address);
    if (!parsed.success) {
      throw new BadRequestException('Invalid Stellar wallet address');
    }

    return this.authService.createChallenge(parsed.data);
  }

  /**
   * Verify a signed challenge and receive a JWT session token.
   *
   * The token is set as an httpOnly, Secure, SameSite=Lax cookie so
   * JavaScript cannot access it (XSS-resistant). The cookie is
   * automatically sent by the browser on subsequent requests.
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a signed challenge and get a session token' })
  async verifyChallenge(
    @Body('challengeId') challengeId: string,
    @Body('address') address: string,
    @Body('signature') signature: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!challengeId || !address || !signature) {
      throw new BadRequestException('challengeId, address, and signature are required');
    }

    const result = await this.authService.verifyChallenge(challengeId, address, signature);

    if (!result.verified) {
      throw new UnauthorizedException(result.error);
    }

    // Set the session token as an httpOnly cookie so JavaScript cannot
    // access it (XSS-resistant). The browser automatically sends it on
    // every request to the gateway.
    //
    // SameSite policy:
    //   production → 'none' + Secure (cross-origin: Vercel dashboard ↔
    //     Railway gateway on different domains; None requires HTTPS).
    //   development → 'lax' (localhost:3000 and localhost:3001 are
    //     same-site; cookies work without HTTPS).
    const config = getConfig();
    const isProduction = config.nodeEnv === 'production';
    res.cookie('x402-session', result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      path: '/',
      maxAge: config.security.sessionDuration * 1000,
    });

    return { verified: true, address, token: result.token };
  }

  /**
   * Validate the current session token.
   * Returns the wallet address if valid.
   *
   * Reads the token from the httpOnly cookie (primary) or the
   * Authorization header (fallback for backward compatibility).
   *
   * When a valid Authorization header token is used (legacy localStorage
   * client), the session cookie is set on this response so subsequent
   * requests use the cookie — this provides seamless migration from
   * localStorage to httpOnly cookie auth.
   */
  @Get('session')
  @ApiOperation({ summary: 'Validate current session' })
  async validateSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('authorization') authHeader?: string,
  ) {
    const token = this.extractTokenFromRequest(req, authHeader);
    const result = await this.authService.validateToken(token);

    if (!result.valid) {
      throw new UnauthorizedException(result.error);
    }

    // Migration: if the client authenticated via Authorization header
    // (legacy localStorage flow), set the httpOnly cookie now so future
    // requests use the cookie instead.
    const hasCookie = !!req.cookies?.['x402-session'];
    if (!hasCookie) {
      const config = getConfig();
      const isProduction = config.nodeEnv === 'production';
      res.cookie('x402-session', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/',
        maxAge: config.security.sessionDuration * 1000,
      });
    }

    return {
      address: result.address,
      sessionId: result.sessionId,
    };
  }

  /**
   * End the current session (logout).
   *
   * Clears the httpOnly session cookie and destroys the server-side session.
   */
  @Delete('session')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'End current session (logout)' })
  async destroySession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('authorization') authHeader?: string,
  ) {
    const token = this.extractTokenFromRequest(req, authHeader);
    const result = await this.authService.validateToken(token);

    if (!result.valid) {
      // Clear the cookie even for invalid tokens — client may have a stale
      // cookie that needs to be removed.
      res.clearCookie('x402-session', { path: '/' });
      throw new UnauthorizedException(result.error);
    }

    if (result.sessionId) {
      await this.authService.destroySession(result.sessionId);
    }

    res.clearCookie('x402-session', { path: '/' });
  }

  /**
   * Extract the session token from the httpOnly cookie (primary) or
   * Authorization header (fallback for backward compatibility with
   * pre-cookie clients).
   */
  private extractTokenFromRequest(req: Request, authHeader?: string): string {
    // Primary: httpOnly cookie (set by /auth/verify)
    const cookieToken = req.cookies?.['x402-session'];
    if (cookieToken) return cookieToken;

    // Fallback: Authorization header (backward compatibility)
    if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length === 2 && parts[0] === 'Bearer') {
        return parts[1];
      }
    }

    throw new UnauthorizedException('Missing session token');
  }
}
