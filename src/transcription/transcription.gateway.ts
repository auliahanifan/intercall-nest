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

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class TranscriptionGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(private logger: LoggerService) {}

  handleConnection(@ConnectedSocket() socket: Socket) {
    const clientInfo = {
      socketId: socket.id,
      clientAddress: socket.handshake.address,
      userAgent: socket.handshake.headers['user-agent'],
      connectedAt: new Date().toISOString(),
    };

    this.logger.log(
      `WebSocket client connected: ${socket.id}`,
      'TranscriptionGateway',
    );
    this.logger.debug(
      `Connection details: ${JSON.stringify(clientInfo)}`,
      'TranscriptionGateway',
    );
  }

  handleDisconnect(@ConnectedSocket() socket: Socket) {
    const disconnectInfo = {
      socketId: socket.id,
      disconnectedAt: new Date().toISOString(),
    };

    this.logger.log(
      `WebSocket client disconnected: ${socket.id}`,
      'TranscriptionGateway',
    );
    this.logger.debug(
      `Disconnect details: ${JSON.stringify(disconnectInfo)}`,
      'TranscriptionGateway',
    );
  }

  @SubscribeMessage('audio_chunk')
  handleAudioChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chunk: any; language: string },
  ) {
    const messageInfo = {
      socketId: socket.id,
      language: data.language,
      chunkSize: data.chunk ? Object.keys(data.chunk).length : 0,
      receivedAt: new Date().toISOString(),
    };

    this.logger.log(
      `Audio chunk received: ${JSON.stringify(messageInfo)}`,
      'TranscriptionGateway',
    );

    return from([1, 2, 3]).pipe(
      map((item) => ({ event: 'events', data: item })),
    );
  }
}
