import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const client: Socket = context.switchToWs().getClient();
    const token = this.extractToken(client);

    if (!token) {
      throw new WsException('Unauthorized - No token provided');
    }

    try {
      const payload = this.jwtService.verify(token);
      client.data.user = payload;
      return true;
    } catch (error) {
      throw new WsException('Unauthorized - Invalid token');
    }
  }

  private extractToken(client: Socket): string | null {
    // Try to get token from auth object first
    const authToken = client.handshake.auth?.token;
    if (authToken) {
      return authToken.startsWith('Bearer ')
        ? authToken.substring(7)
        : authToken;
    }

    // Fallback to authorization header
    const authHeader = client.handshake.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return authHeader || null;
  }
}
