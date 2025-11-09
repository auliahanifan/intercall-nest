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
import { PrismaService } from '../database/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { QuotaExceededException } from '../subscription/exceptions/quota-exceeded.exception';

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
  private cleaningUp = new Set<string>();

  constructor(
    private logger: LoggerService,
    private transcriptionService: TranscriptionService,
    private prisma: PrismaService,
    private subscriptionService: SubscriptionService,
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

      // Get activeOrganizationId from session
      const activeOrganizationId = (session as any).activeOrganizationId;
      (socket as any).activeOrganizationId = activeOrganizationId;

      const clientInfo = {
        socketId: socket.id,
        userId: session.user.id,
        userEmail: session.user.email,
        conversationId,
        targetLanguage,
        organizationId: activeOrganizationId,
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

      // Check quota before initializing connection
      if (!activeOrganizationId) {
        this.logger.warn(
          `No active organization found for user ${session.user.id}. Disconnecting.`,
          'TranscriptionGateway',
        );
        socket.disconnect();
        return;
      }

      try {
        await this.subscriptionService.checkQuotaAvailability(activeOrganizationId);
        this.logger.log(
          `Quota check passed for organization ${activeOrganizationId}`,
          'TranscriptionGateway',
        );
      } catch (error) {
        if (error instanceof QuotaExceededException) {
          this.logger.warn(
            `Quota exceeded for organization ${activeOrganizationId}: ${error.message}`,
            'TranscriptionGateway',
          );
          socket.emit('quota:exceeded', {
            error: error['response'].error,
            data: error['response'].data,
          });
        } else {
          this.logger.error(
            `Quota check failed: ${error.message}`,
            'TranscriptionGateway',
          );
        }
        socket.disconnect();
        return;
      }

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

  async handleDisconnect(@ConnectedSocket() socket: Socket) {
    const userId = (socket as any).user?.id;
    const conversationId = (socket as any).conversationId;

    // Idempotency guard: prevent duplicate processing
    if (!conversationId || this.cleaningUp.has(conversationId)) {
      return;
    }

    this.cleaningUp.add(conversationId);

    try {
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

      // Fix memory leak: unsubscribe RxJS subscription
      const subscription = this.conversationSubscriptions.get(conversationId);
      if (subscription) {
        subscription.unsubscribe();
        this.conversationSubscriptions.delete(conversationId);
      }

      // Close Soniox connection
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

      // Save transcription results to database
      try {
        const results =
          this.transcriptionService.getConversationResults(conversationId);
        const organizationId = (socket as any).activeOrganizationId;

        if (organizationId) {
          await this.prisma.transcription.create({
            data: {
              id: conversationId,
              organizationId,
              durationInMs: results.durationInMs,
              modelName: 'stt-rt-v3',
              targetLanguage: results.targetLanguage,
              sourceLanguage: results.sourceLanguage,
              transcriptionResult: results.transcriptionResult || '',
              translationResult: results.translationResult || '',
              vocabularies: results.vocabularies,
            },
          });
          this.logger.log(
            `Transcription saved for conversation ${conversationId}`,
            'TranscriptionGateway',
          );

          // Record usage in subscription
          try {
            await this.subscriptionService.recordUsage(
              organizationId,
              BigInt(results.durationInMs),
            );
            this.logger.log(
              `Usage recorded for organization ${organizationId}: ${Number(results.durationInMs) / 60000} minutes`,
              'TranscriptionGateway',
            );
          } catch (error) {
            this.logger.error(
              `Failed to record usage: ${error.message}`,
              'TranscriptionGateway',
            );
            // Continue with cleanup even if usage recording fails
          }
        } else {
          this.logger.warn(
            `Missing organizationId for conversation ${conversationId}. Skipping database save.`,
            'TranscriptionGateway',
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to save transcription: ${error.message}`,
          'TranscriptionGateway',
        );
        // Continue with cleanup even if save fails
      }

      // Cleanup service data
      this.transcriptionService.cleanupConversation(conversationId);
    } finally {
      // Remove from cleanup set
      this.cleaningUp.delete(conversationId);
    }
  }

  @SubscribeMessage('audio_chunk')
  async handleAudioChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: AudioChunkDto,
  ) {
    try {
      const userId = (socket as any).user?.id;
      const { transcriptionId } = data;
      // Use targetLanguage from socket connection (source of truth), not from audio chunk
      const targetLanguage = (socket as any).targetLanguage;

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
            // Cleanup on error
            const errorSubscription =
              this.conversationSubscriptions.get(transcriptionId);
            if (errorSubscription) {
              errorSubscription.unsubscribe();
              this.conversationSubscriptions.delete(transcriptionId);
            }
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
