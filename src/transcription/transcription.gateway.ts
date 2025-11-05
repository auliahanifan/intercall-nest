import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { LoggerService } from '../common/logger/logger.service';
import { auth } from '../lib/auth';
import { AudioChunkDto, TranslationResultDto } from './dto';
import { TranscriptionService } from './transcription.service';

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

  private conversationSubscriptions = new Map<string, any>();

  constructor(
    private logger: LoggerService,
    private transcriptionService: TranscriptionService,
  ) {}

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

      // Extract conversationId and targetLanguage from query parameters
      const conversationId = socket.handshake.query.conversationId as string;
      const targetLanguage = socket.handshake.query.targetLanguage as string;

      if (!conversationId || !targetLanguage) {
        this.logger.warn(
          `Missing conversationId or targetLanguage for socket ${socket.id}`,
          'TranscriptionGateway',
        );
        socket.disconnect();
        return;
      }

      (socket as any).conversationId = conversationId;
      (socket as any).targetLanguage = targetLanguage;

      const clientInfo = {
        socketId: socket.id,
        userId: session.user.id,
        userEmail: session.user.email,
        conversationId,
        targetLanguage,
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

      // Initialize Soniox connection immediately
      try {
        await this.transcriptionService.initializeConversation(
          conversationId,
          targetLanguage,
        );
        this.logger.log(
          `Soniox connection initialized for conversation ${conversationId}`,
          'TranscriptionGateway',
        );
      } catch (error) {
        this.logger.error(
          `Failed to initialize Soniox connection: ${error.message}`,
          'TranscriptionGateway',
        );
        socket.disconnect();
        return;
      }
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
    const conversationId = (socket as any).conversationId;

    const disconnectInfo = {
      socketId: socket.id,
      userId: userId,
      conversationId: conversationId,
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

    // Clean up Soniox connection if exists
    if (conversationId) {
      try {
        this.transcriptionService.closeConversation(conversationId);
        this.logger.log(
          `Soniox connection closed for conversation ${conversationId}`,
          'TranscriptionGateway',
        );
      } catch (error) {
        this.logger.error(
          `Failed to close Soniox connection: ${error.message}`,
          'TranscriptionGateway',
        );
      }
    }
  }

  @SubscribeMessage('audio_chunk')
  async handleAudioChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: AudioChunkDto,
  ) {
    try {
      const userId = (socket as any).user?.id;
      const { transcriptionId, language: targetLanguage } = data;

      const messageInfo = {
        socketId: socket.id,
        userId: userId,
        conversationId: transcriptionId,
        targetLanguage,
        chunkSize: data.chunk_base64.length, // Length of base64 string
        receivedAt: new Date().toISOString(),
      };

      this.logger.log(
        `Audio chunk received: ${JSON.stringify(messageInfo)}`,
        'TranscriptionGateway',
      );

      // Decode the Base64 string back to a Buffer
      const audioBuffer = Buffer.from(data.chunk_base64, 'base64');

      // Send audio chunk to transcription service (auto-initializes on first chunk)
      const resultSubject = await this.transcriptionService.transcribeRealTime(
        transcriptionId,
        null, // Source language is unknown, will be auto-detected
        targetLanguage,
        audioBuffer,
      );

      // Subscribe to results if not already subscribed for this conversation
      if (!this.conversationSubscriptions.has(transcriptionId)) {
        const subscription = resultSubject.subscribe({
          next: (result: TranslationResultDto) => {
            socket.emit('translation:result', result);
          },
          error: (error) => {
            this.logger.error(
              `Conversation error: ${error.message}`,
              'TranscriptionGateway',
            );
            socket.emit('transcription:error', {
              message: error.message,
              transcriptionId,
            });
          },
          complete: () => {
            this.logger.log(
              `Conversation completed: ${transcriptionId}`,
              'TranscriptionGateway',
            );
            socket.emit('conversation:complete', {
              conversationId: transcriptionId,
            });
            this.conversationSubscriptions.delete(transcriptionId);
          },
        });

        this.conversationSubscriptions.set(transcriptionId, subscription);
      }
    } catch (error) {
      this.logger.error(
        `Failed to process audio chunk: ${error.message}`,
        'TranscriptionGateway',
      );
      socket.emit('transcription:error', {
        message: error.message,
      });
    }
  }
}
