import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
} from '@nestjs/websockets';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { Server, Socket } from 'socket.io';
import { LoggerService } from '../common/logger/logger.service';
import { auth } from '../lib/auth';

@WebSocketGateway({
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:3000',
      'http://localhost:8080',
    ],
    credentials: true,
  },
})
export class TranscriptionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private logger: LoggerService) {}

  async handleConnection(@ConnectedSocket() socket: Socket) {
    try {
      const cookies = socket.handshake.headers.cookie;

      if (!cookies) {
        this.logger.warn(
          `No cookies provided for socket ${socket.id}`,
          'TranscriptionGateway',
        );
        socket.disconnect();
        return;
      }

      const session = await auth.api.getSession({
        headers: {
          cookie: cookies,
        } as any,
      });

      if (!session || !session.user) {
        this.logger.warn(
          `Invalid or expired session for socket ${socket.id}`,
          'TranscriptionGateway',
        );
        socket.disconnect();
        return;
      }

      (socket as any).user = session.user;
      (socket as any).session = session;

      const clientInfo = {
        socketId: socket.id,
        userId: session.user.id,
        userEmail: session.user.email,
        clientAddress: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
        connectedAt: new Date().toISOString(),
      };

      this.logger.log(
        `WebSocket client connected: ${socket.id} (user: ${session.user.id})`,
        'TranscriptionGateway',
      );
      this.logger.log(
        `Connection details: ${JSON.stringify(clientInfo)}`,
        'TranscriptionGateway',
      );
    } catch (error) {
      this.logger.error(
        `Auth failed for socket ${socket.id}: ${error.message}`,
        'TranscriptionGateway',
      );
      socket.disconnect();
    }
  }

  handleDisconnect(@ConnectedSocket() socket: Socket) {
    const userId = (socket as any).user?.id;
    const disconnectInfo = {
      socketId: socket.id,
      userId: userId,
      disconnectedAt: new Date().toISOString(),
    };

    this.logger.log(
      `WebSocket client disconnected: ${socket.id} (user: ${userId})`,
      'TranscriptionGateway',
    );
    this.logger.log(
      `Disconnect details: ${JSON.stringify(disconnectInfo)}`,
      'TranscriptionGateway',
    );
  }

  @SubscribeMessage('audio_chunk')
  handleAudioChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chunk: any; language: string },
  ) {
    const userId = (socket as any).user?.id;
    const messageInfo = {
      socketId: socket.id,
      userId: userId,
      language: data.language,
      chunkSize: data.chunk ? Object.keys(data.chunk).length : 0,
      receivedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Audio chunk received from user ${userId}: ${JSON.stringify(messageInfo)}`,
      'TranscriptionGateway',
    );

    return from([1, 2, 3]).pipe(
      map((item) => ({ event: 'events', data: item })),
    );
  }
}
