import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConsolidatedBalanceDto } from './dto/balance-response.dto';

interface BalanceUpdatedPayload {
  userId: string;
  data: ConsolidatedBalanceDto;
}

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/balances',
})
export class BalancesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(BalancesGateway.name);

  @WebSocketServer()
  server: Server;

  afterInit(): void {
    this.logger.log('Balances WebSocket Gateway initialized');
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected to balances: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected from balances: ${client.id}`);
  }

  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() userId: string,
  ): void {
    this.logger.log(`Client ${client.id} joining room for user: ${userId}`);
    client.join(`user:${userId}`);
    client.emit('joined', { userId });
  }

  @SubscribeMessage('leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() userId: string,
  ): void {
    this.logger.log(`Client ${client.id} leaving room for user: ${userId}`);
    client.leave(`user:${userId}`);
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  @OnEvent('balance.updated')
  handleBalanceUpdated(payload: BalanceUpdatedPayload): void {
    this.logger.log(`Emitting balance update for user: ${payload.userId}`);
    this.server.to(`user:${payload.userId}`).emit('balance:updated', payload.data);
  }
}
