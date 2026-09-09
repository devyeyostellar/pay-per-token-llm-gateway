import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Primary: httpOnly cookie (XSS-resistant, set by /auth/verify).
    // Fallback: Authorization header (backward compat for pre-cookie clients).
    const cookieToken = request.cookies?.['x402-session'];
    const authHeader = request.headers['authorization'];

    let token: string;
    if (cookieToken) {
      token = cookieToken;
    } else if (authHeader) {
      const parts = authHeader.split(' ');
      if (parts.length !== 2 || parts[0] !== 'Bearer') {
        throw new UnauthorizedException('Invalid authorization format. Use: Bearer <token>');
      }
      token = parts[1];
    } else {
      throw new UnauthorizedException('Missing session token');
    }

    const result = await this.authService.validateToken(token);

    if (!result.valid) {
      throw new UnauthorizedException(result.error);
    }

    // Attach authenticated address to the request for downstream use
    Object.assign(request, {
      authenticatedAddress: result.address,
      sessionId: result.sessionId,
    });

    return true;
  }
}
