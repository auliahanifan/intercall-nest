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
import { TranscriptionStatus } from '../../generated/prisma/enums';
import { LoggerService } from '../common/logger/logger.service';
import { auth } from '../lib/auth';
import { TranslationResultDto } from './dto';
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
  private periodicSaveIntervals = new Map<string, NodeJS.Timeout>();
  private sessionMap = new Map<string, { language: string; transcriptionId: string; terms?: string[] }>();

  constructor(
    private logger: LoggerService,
    private transcriptionService: TranscriptionService,
    private prisma: PrismaService,
    private subscriptionService: SubscriptionService,
  ) {}

  /**
   * Save transcription with retry logic and exponential backoff
   * Retries up to 3 times with delays of 1s, 2s, and 4s
   */
  private async saveTranscriptionWithRetry(
    data: any,
    conversationId: string,
    maxRetries: number = 3,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `Saving transcription (attempt ${attempt}/${maxRetries}): conversationId=${conversationId}`,
          'TranscriptionGateway',
        );

        await this.prisma.transcription.create({ data });

        this.logger.log(
          `Transcription saved successfully: conversationId=${conversationId}`,
          'TranscriptionGateway',
        );
        return; // Success, exit
      } catch (error) {
        lastError = error;

        // Check if error is retryable (network/timeout issues)
        const isRetryableError =
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('timeout') ||
          error.message?.includes('connection');

        if (!isRetryableError || attempt === maxRetries) {
          // Non-retryable error or last attempt - break and throw
          break;
        }

        // Calculate backoff delay: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(
          `Save failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms`,
          'TranscriptionGateway',
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // All retries exhausted
    throw lastError || new Error('Failed to save transcription after retries');
  }

  /**
   * Save final transcription with retry logic using upsert
   * Handles case where periodic updates already created the record
   */
  private async saveFinalTranscriptionWithRetry(
    data: {
      id: string;
      organizationId: string;
      durationInMs: bigint;
      modelName: string;
      targetLanguage: string;
      sourceLanguage?: string | null;
      transcriptionResult: string | null;
      translationResult: string | null;
      vocabularies: any;
      status: TranscriptionStatus;
    },
    conversationId: string,
    maxRetries: number = 3,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `Final transcription save (attempt ${attempt}/${maxRetries}): conversationId=${conversationId}, status=${data.status}`,
          'TranscriptionGateway',
        );

        // Use upsert to handle case where periodic save already created the record
        await this.prisma.transcription.upsert({
          where: { id: conversationId },
          create: data,
          update: {
            durationInMs: data.durationInMs,
            targetLanguage: data.targetLanguage,
            sourceLanguage: data.sourceLanguage,
            transcriptionResult: data.transcriptionResult,
            translationResult: data.translationResult,
            vocabularies: data.vocabularies,
            status: data.status,
          },
        });

        this.logger.log(
          `Final transcription saved successfully: conversationId=${conversationId}, status=${data.status}`,
          'TranscriptionGateway',
        );
        return; // Success, exit
      } catch (error) {
        lastError = error;

        // Check if error is retryable (network/timeout issues)
        const isRetryableError =
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('timeout') ||
          error.message?.includes('connection');

        if (!isRetryableError || attempt === maxRetries) {
          // Non-retryable error or last attempt - break and throw
          break;
        }

        // Calculate backoff delay: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(
          `Final save failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms`,
          'TranscriptionGateway',
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // All retries exhausted
    throw lastError || new Error('Failed to save final transcription after retries');
  }

  /**
   * Save periodic updates every 1 minute during active transcription
   * Uses upsert to handle both create and update scenarios
   */
  private async savePeriodicUpdate(
    conversationId: string,
    organizationId: string,
  ): Promise<void> {
    let lastError: Error | null = null;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Get current accumulated results
        const results =
          this.transcriptionService.getConversationResults(conversationId);

        // Skip if no data received yet
        if (
          !results.transcriptionResult &&
          !results.translationResult
        ) {
          this.logger.debug(
            `Skipping periodic save - no data yet for ${conversationId}`,
            'TranscriptionGateway',
          );
          return;
        }

        // Validate we have a target language
        if (!results.targetLanguage || results.targetLanguage.trim().length === 0) {
          this.logger.warn(
            `Skipping periodic save - missing targetLanguage for ${conversationId}`,
            'TranscriptionGateway',
          );
          return;
        }

        this.logger.log(
          `Periodic update (attempt ${attempt}/${maxRetries}): conversationId=${conversationId}, ` +
            `transcriptionLength=${results.transcriptionResult?.length || 0}, ` +
            `translationLength=${results.translationResult?.length || 0}`,
          'TranscriptionGateway',
        );

        // Use upsert to create or update the record
        await this.prisma.transcription.upsert({
          where: { id: conversationId },
          create: {
            id: conversationId,
            organizationId,
            durationInMs: BigInt(results.durationInMs),
            modelName: 'stt-rt-v3',
            targetLanguage: results.targetLanguage,
            sourceLanguage: results.sourceLanguage,
            transcriptionResult: results.transcriptionResult,
            translationResult: results.translationResult,
            vocabularies: results.vocabularies,
            status: TranscriptionStatus.IN_PROGRESS,
          },
          update: {
            durationInMs: BigInt(results.durationInMs),
            transcriptionResult: results.transcriptionResult,
            translationResult: results.translationResult,
            vocabularies: results.vocabularies,
            status: TranscriptionStatus.IN_PROGRESS,
          },
        });

        this.logger.log(
          `Periodic update saved successfully: conversationId=${conversationId}`,
          'TranscriptionGateway',
        );
        return; // Success, exit
      } catch (error) {
        lastError = error;

        // Check if error is retryable (network/timeout issues)
        const isRetryableError =
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('timeout') ||
          error.message?.includes('connection') ||
          error.message?.includes('deadlock');

        if (!isRetryableError || attempt === maxRetries) {
          // Non-retryable error or last attempt - log and return (don't throw)
          this.logger.error(
            `Periodic update failed for ${conversationId} (attempt ${attempt}/${maxRetries}): ${error.message}. Will retry on next interval.`,
            'TranscriptionGateway',
          );
          return; // Return instead of throwing - session continues
        }

        // Calculate backoff delay: 1s, 2s, 4s
        const delayMs = Math.pow(2, attempt - 1) * 1000;
        this.logger.warn(
          `Periodic update failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delayMs}ms`,
          'TranscriptionGateway',
        );

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

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
      const activeOrganizationId = (session.user as any).activeOrganizationId;
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

        // Set up session in sessionMap so audio chunks can be processed immediately
        this.sessionMap.set(socket.id, {
          language: targetLanguage,
          transcriptionId: conversationId,
        });
        this.logger.log(
          `Session created in sessionMap for socket ${socket.id}: conversationId=${conversationId}, language=${targetLanguage}`,
          'TranscriptionGateway',
        );

        // Start periodic save interval (every 60 seconds = 1 minute)
        const saveInterval = setInterval(
          () => this.savePeriodicUpdate(conversationId, activeOrganizationId),
          60000,
        );
        this.periodicSaveIntervals.set(conversationId, saveInterval);

        this.logger.log(
          `Started periodic save interval for conversation ${conversationId} (every 60 seconds)`,
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

      // Clear periodic save interval
      const saveInterval = this.periodicSaveIntervals.get(conversationId);
      if (saveInterval) {
        clearInterval(saveInterval);
        this.periodicSaveIntervals.delete(conversationId);
        this.logger.log(
          `Cleared periodic save interval for ${conversationId}`,
          'TranscriptionGateway',
        );
      }

      // Clear session information
      this.sessionMap.delete(socket.id);
      this.logger.log(
        `Cleared session for socket ${socket.id}`,
        'TranscriptionGateway',
      );

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
          // Validate and determine status
          const hasReceivedData = results.hasReceivedData;
          const hasError = results.hasError;

          const hasValidTargetLanguage =
            results.targetLanguage &&
            results.targetLanguage.trim().length > 0;

          // Determine final status:
          // - COMPLETED: Has data (preserves partial data from errors)
          // - FAILED: No data but errors occurred
          // - NO_DATA: No data and no errors
          let finalStatus: TranscriptionStatus;
          if (hasReceivedData) {
            // ALWAYS save data if we received any, even if errors occurred
            finalStatus = TranscriptionStatus.COMPLETED;
          } else if (hasError) {
            // Errors occurred but no data received
            finalStatus = TranscriptionStatus.FAILED;
          } else {
            // No errors and no data (normal timeout or quick disconnect)
            finalStatus = TranscriptionStatus.NO_DATA;
          }

          // Log detailed information about what we're saving
          this.logger.log(
            `Preparing to save transcription - conversationId: ${conversationId}, ` +
              `targetLanguage: ${results.targetLanguage || 'null'}, ` +
              `transcriptionLength: ${results.transcriptionResult?.length || 0}, ` +
              `translationLength: ${results.translationResult?.length || 0}, ` +
              `hasReceivedData: ${hasReceivedData}, ` +
              `hasError: ${hasError}, ` +
              `finalStatus: ${finalStatus}, ` +
              `durationMs: ${results.durationInMs}`,
            'TranscriptionGateway',
          );

          // Only save if we have a valid target language and organization
          if (!hasValidTargetLanguage) {
            this.logger.warn(
              `Missing or invalid targetLanguage for conversation ${conversationId}. Status: ${finalStatus}. Skipping save.`,
              'TranscriptionGateway',
            );
          } else {
            try {
              const saveData = {
                id: conversationId,
                organizationId,
                durationInMs: BigInt(results.durationInMs),
                modelName: 'stt-rt-v3',
                targetLanguage: results.targetLanguage,
                sourceLanguage: results.sourceLanguage,
                transcriptionResult: hasReceivedData
                  ? results.transcriptionResult
                  : null,
                translationResult: hasReceivedData
                  ? results.translationResult
                  : null,
                vocabularies: hasReceivedData ? results.vocabularies : null,
                status: finalStatus,
              };

              // Save with retry logic (upsert handles periodic saves that already created record)
              await this.saveFinalTranscriptionWithRetry(
                saveData,
                conversationId,
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
            } catch (saveError) {
              this.logger.error(
                `Failed to save transcription after retries: ${saveError.message}`,
                'TranscriptionGateway',
              );
              // Continue with cleanup even if save fails
            }
          }
        } else {
          this.logger.warn(
            `Missing organizationId for conversation ${conversationId}. Skipping database save.`,
            'TranscriptionGateway',
          );
        }
      } catch (error) {
        this.logger.error(
          `Error during transcription save process: ${error.message}`,
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

  @SubscribeMessage('start_recording')
  handleStartRecording(@ConnectedSocket() socket: Socket) {
    try {
      const conversationId = (socket as any).conversationId;
      const userId = (socket as any).user?.id;

      this.logger.log(
        `Start recording event received: conversationId=${conversationId}, userId=${userId}`,
        'TranscriptionGateway',
      );

      // Notify transcription service to start tracking recording time
      this.transcriptionService.startRecordingSession(conversationId);

      socket.emit('recording:started', {
        conversationId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to start recording: ${error.message}`,
        'TranscriptionGateway',
      );
      socket.emit('recording:error', {
        message: error.message,
      });
    }
  }

  @SubscribeMessage('stop_recording')
  async handleStopRecording(@ConnectedSocket() socket: Socket) {
    try {
      const conversationId = (socket as any).conversationId;
      const userId = (socket as any).user?.id;
      const organizationId = (socket as any).activeOrganizationId;

      this.logger.log(
        `Stop recording event received: conversationId=${conversationId}, userId=${userId}`,
        'TranscriptionGateway',
      );

      // Notify transcription service to stop recording and accumulate duration
      this.transcriptionService.stopRecordingSession(conversationId);

      const recordingDuration =
        this.transcriptionService.getRecordingDuration(conversationId);

      // Save current transcription to database (without finalizing session)
      // This happens on pause - session remains active for potential resume
      try {
        await this.savePeriodicUpdate(conversationId, organizationId);
        this.logger.log(
          `Transcription saved on pause for conversation ${conversationId}`,
          'TranscriptionGateway',
        );
      } catch (saveError) {
        this.logger.warn(
          `Failed to save transcription on pause: ${saveError.message}`,
          'TranscriptionGateway',
        );
        // Continue - don't fail the pause operation due to save failure
      }

      socket.emit('recording:stopped', {
        conversationId,
        durationMs: recordingDuration,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(
        `Failed to stop recording: ${error.message}`,
        'TranscriptionGateway',
      );
      socket.emit('recording:error', {
        message: error.message,
      });
    }
  }

  @SubscribeMessage('audio_chunk')
  async handleAudioChunk(
    @ConnectedSocket() socket: Socket,
    @MessageBody() chunk: Buffer,
  ) {
    try {
      const userId = (socket as any).user?.id;

      // Get session information from the sessionMap
      const sessionInfo = this.sessionMap.get(socket.id);
      if (!sessionInfo) {
        this.logger.error(
          `No session found for socket ${socket.id}. Connection session was not initialized.`,
          'TranscriptionGateway',
        );
        socket.emit('transcription:error', {
          message: 'Session not initialized. Please reconnect.',
        });
        return;
      }

      const { transcriptionId, language: targetLanguage } = sessionInfo;

      const messageInfo = {
        socketId: socket.id,
        userId: userId,
        conversationId: transcriptionId,
        targetLanguage,
        chunkSize: chunk.length, // Length in bytes
        receivedAt: new Date().toISOString(),
      };

      this.logger.log(
        `Audio chunk received: ${JSON.stringify(messageInfo)}`,
        'TranscriptionGateway',
      );

      // Use the binary buffer directly (no decoding needed)
      const audioBuffer = chunk;

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
