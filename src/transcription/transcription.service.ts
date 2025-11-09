import { Injectable, Logger } from '@nestjs/common';
import { AudioChunkDto, TranslationResultDto } from './dto';
import WebSocket from 'ws';
import { Subject } from 'rxjs';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private sonioxConnectionPromises = new Map<string, Promise<WebSocket>>();
  private conversationData = new Map<string, any>();
  private conversationSubjects = new Map<
    string,
    Subject<TranslationResultDto>
  >();
  private accumulatedResults = new Map<
    string,
    {
      originalTokens: string[];
      translationTokens: string[];
      startTime: Date;
      targetLanguage: string;
      sourceLanguage?: string;
      vocabularies: any;
      hasReceivedData: boolean;
      hasError: boolean;
      lastOriginalSpeaker: string | null;
      lastTranslationSpeaker: string | null;
      recordingStartTime: Date | null;
      totalRecordingDurationMs: number;
      isCurrentlyRecording: boolean;
      recordingSegments: Array<{ startTime: Date; endTime: Date | null }>;
      // New fields for tracking final segments with JSON format
      finalOriginalSegments: Array<{ role: string; text: string; timestamp: number }>;
      finalTranslationSegments: Array<{ role: string; text: string; timestamp: number }>;
    }
  >();

  constructor() {}

  /**
   * Helper method to append a final token to segments
   * Combines with previous segment if same speaker, otherwise creates new segment
   */
  private appendFinalSegment(
    segments: Array<{ role: string; text: string; timestamp: number }>,
    speaker: string,
    text: string,
    timestamp: number,
  ): void {
    // Check if we can append to the last segment (same speaker)
    if (segments.length > 0 && segments[segments.length - 1].role === speaker) {
      // Append to existing segment
      segments[segments.length - 1].text += text;
    } else {
      // Create new segment
      segments.push({ role: speaker, text, timestamp });
    }
  }

  /**
   * Initialize Soniox connection immediately when socket connects
   * This is called from the WebSocket gateway during connection setup
   */
  async initializeConversation(
    conversationId: string,
    targetLanguage: string,
    sourceLanguage: string | null = null,
    vocabularies: any = null,
  ): Promise<void> {
    // Create or get the subject for this conversation
    let resultSubject = this.conversationSubjects.get(conversationId);
    if (!resultSubject) {
      resultSubject = new Subject<TranslationResultDto>();
      this.conversationSubjects.set(conversationId, resultSubject);
    }

    // Check if connection already exists
    if (this.sonioxConnectionPromises.has(conversationId)) {
      this.logger.log(`Soniox connection already exists for ${conversationId}`);
      return;
    }

    // Store conversation metadata
    this.conversationData.set(conversationId, {
      sourceLanguage,
      targetLanguage,
    });

    // Initialize accumulated results tracker
    this.accumulatedResults.set(conversationId, {
      originalTokens: [],
      translationTokens: [],
      startTime: new Date(),
      targetLanguage,
      sourceLanguage: sourceLanguage || undefined,
      vocabularies,
      hasReceivedData: false,
      hasError: false,
      lastOriginalSpeaker: null,
      lastTranslationSpeaker: null,
      recordingStartTime: null,
      totalRecordingDurationMs: 0,
      isCurrentlyRecording: false,
      recordingSegments: [],
      finalOriginalSegments: [],
      finalTranslationSegments: [],
    });

    // Create the connection promise
    const connectionPromise = this.initializeSonioxConnection(
      conversationId,
      sourceLanguage,
      targetLanguage,
      resultSubject,
    );

    this.sonioxConnectionPromises.set(conversationId, connectionPromise);

    // Handle connection events
    connectionPromise
      .then((ws) => {
        ws.on('close', () => {
          this.logger.log(
            `Connection closed for ${conversationId}, removing promise from map.`,
          );
          this.sonioxConnectionPromises.delete(conversationId);
        });
      })
      .catch((error) => {
        this.logger.error(
          `Connection promise rejected for ${conversationId}`,
          error,
        );
        this.sonioxConnectionPromises.delete(conversationId);
      });

    // Wait for connection to establish
    await connectionPromise;
  }

  /**
   * Close Soniox connection for a conversation
   */
  closeConversation(conversationId: string): void {
    const connectionPromise = this.sonioxConnectionPromises.get(conversationId);
    if (connectionPromise) {
      connectionPromise
        .then((ws) => {
          if (ws && ws.readyState !== WebSocket.CLOSED) {
            ws.close();
          }
        })
        .catch((error) => {
          this.logger.error(
            `Error closing connection for ${conversationId}`,
            error,
          );
        });
    }
  }

  /**
   * Initialize Soniox connection for a conversation (auto-called on first audio chunk)
   */
  private initializeSonioxConnection(
    conversationId: string,
    sourceLanguage: string | null,
    targetLanguage: string,
    resultSubject: Subject<TranslationResultDto>,
  ): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      try {
        // Initialize Soniox WebSocket connection
        const ws = new WebSocket(
          'wss://stt-rt.soniox.com/transcribe-websocket',
        );

        ws.on('open', () => {
          this.logger.debug(
            `Soniox connection opened for conversation: ${conversationId}`,
          );

          // Send configuration to Soniox
          const config: any = {
            api_key: process.env.SONIOX_API_KEY,
            model: 'stt-rt-v3',
            enable_language_identification: true,
            enable_speaker_diarization: true,
            enable_endpoint_detection: true,
            audio_format: 'pcm_s16le',
            sample_rate: 16000,
            num_channels: 1,
            translation: {
              type: 'one_way',
              target_language: targetLanguage,
            },
          };

          // Always include language_hints for Soniox accuracy
          // Use source language if provided, otherwise use common language defaults
          config.language_hints = sourceLanguage ? [sourceLanguage] : [];

          ws.send(JSON.stringify(config));
          resolve(ws);
        });

        ws.on('message', async (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.logger.log('Soniox get message', message);
            await this.handleSonioxMessage(
              conversationId,
              message,
              resultSubject,
            );
          } catch (error) {
            this.logger.error(`Error parsing Soniox message: ${error}`);
            resultSubject.error(error);
          }
        });

        ws.on('error', (error) => {
          this.logger.error(
            `Soniox WebSocket error for conversation ${conversationId}: ${error}`,
          );
          resultSubject.error(error);
          reject(error);
        });

        ws.on('close', () => {
          this.logger.debug(
            `Soniox connection closed for conversation: ${conversationId}`,
          );
          this.conversationData.delete(conversationId);
          this.conversationSubjects.delete(conversationId);
          resultSubject.complete();
        });
      } catch (error) {
        this.logger.error(`Failed to initialize Soniox connection: ${error}`);
        resultSubject.error(error);
        reject(error);
      }
    });
  }

  /**
   * Handle audio chunk - auto-initializes Soniox on first chunk
   */
  async transcribeRealTime(
    conversationId: string,
    sourceLanguage: string | null, // Can be null if unknown
    targetLanguage: string,
    chunk: Buffer,
  ): Promise<Subject<TranslationResultDto>> {
    // Get or create Subject for this conversation
    let resultSubject = this.conversationSubjects.get(conversationId);
    if (!resultSubject) {
      resultSubject = new Subject<TranslationResultDto>();
      this.conversationSubjects.set(conversationId, resultSubject);
    }

    try {
      // Check if a connection promise already exists
      let connectionPromise = this.sonioxConnectionPromises.get(conversationId);

      if (!connectionPromise) {
        this.logger.log(
          `No existing connection promise for ${conversationId}, creating new one.`,
        );

        // Store conversation metadata
        this.conversationData.set(conversationId, {
          sourceLanguage,
          targetLanguage,
        });

        // Initialize accumulated results tracker if not already done
        if (!this.accumulatedResults.has(conversationId)) {
          this.accumulatedResults.set(conversationId, {
            originalTokens: [],
            translationTokens: [],
            startTime: new Date(),
            targetLanguage,
            sourceLanguage: sourceLanguage || undefined,
            vocabularies: null,
            hasReceivedData: false,
            hasError: false,
            lastOriginalSpeaker: null,
            lastTranslationSpeaker: null,
            recordingStartTime: null,
            totalRecordingDurationMs: 0,
            isCurrentlyRecording: false,
            recordingSegments: [],
            finalOriginalSegments: [],
            finalTranslationSegments: [],
          });
        }

        // Create a new connection and store the promise immediately
        connectionPromise = this.initializeSonioxConnection(
          conversationId,
          sourceLanguage,
          targetLanguage,
          resultSubject,
        );
        this.sonioxConnectionPromises.set(conversationId, connectionPromise);

        // Handle connection events to remove the promise from the map when done
        connectionPromise
          .then((ws) => {
            ws.on('close', () => {
              this.logger.log(
                `Connection closed for ${conversationId}, removing promise from map.`,
              );
              this.sonioxConnectionPromises.delete(conversationId);
            });
          })
          .catch((error) => {
            this.logger.error(
              `Connection promise rejected for ${conversationId}`,
              error,
            );
            this.sonioxConnectionPromises.delete(conversationId);
          });
      } else {
        this.logger.log(
          `Reusing existing connection promise for ${conversationId}`,
        );
      }

      // Wait for the connection promise to resolve
      const ws = await connectionPromise;

      // Send audio data to Soniox (raw binary)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else {
        this.logger.warn(
          `WebSocket not ready for conversation: ${conversationId}. State: ${
            ws?.readyState
          }`,
        );
      }

      return resultSubject;
    } catch (error) {
      this.logger.error(`Error processing audio chunk: ${error}`);
      resultSubject.error(error);
      // Remove dead subject so next chunk creates fresh one
      this.conversationSubjects.delete(conversationId);
      this.accumulatedResults.delete(conversationId);
      throw error; // Propagate error instead of returning dead subject
    }
  }

  /**
   * Handle messages from Soniox WebSocket
   */
  private async handleSonioxMessage(
    conversationId: string,
    message: any,
    resultSubject: Subject<TranslationResultDto>,
  ): Promise<void> {
    const convData = this.conversationData.get(conversationId);
    const accumulator = this.accumulatedResults.get(conversationId);

    if (!convData) {
      this.logger.warn(`Conversation data not found: ${conversationId}`);
      return;
    }

    // CRITICAL: Check if accumulator exists (indicates race condition or initialization issue)
    if (!accumulator) {
      this.logger.error(
        `CRITICAL: Accumulator not found for conversation ${conversationId}. Tokens will be lost! This indicates a race condition between socket connection and Soniox message arrival.`,
      );
      return;
    }

    // Handle error responses from Soniox
    if (message.error_code) {
      this.logger.error(
        `Soniox error: ${message.error_code} - ${message.error_message} for conversation ${conversationId}`,
      );

      // CRITICAL: Mark error but KEEP accumulator for final save to prevent data loss
      accumulator.hasError = true;

      // Emit error event to client
      resultSubject.error(new Error(message.error_message));

      // Remove dead subject so next chunk creates fresh one
      this.conversationSubjects.delete(conversationId);

      // DO NOT delete accumulatedResults here - let handleDisconnect() save it first
      // This prevents data loss when Soniox errors occur
      this.logger.warn(
        `Soniox error recorded for conversation ${conversationId}. Preserving accumulated data for final save. hasReceivedData=${accumulator.hasReceivedData}, transcriptionLength=${accumulator.originalTokens.join('').length}`,
      );

      return;
    }

    // Process tokens array
    if (message.tokens && Array.isArray(message.tokens)) {
      for (const token of message.tokens) {
        if (token.text) {
          // Mark that we've received data (accumulator is guaranteed non-null at this point)
          accumulator.hasReceivedData = true;

          // Determine if this is original or translation
          const tokenType =
            token.translation_status === 'translation'
              ? 'translation'
              : 'original';
          const tokenLanguage =
            tokenType === 'translation'
              ? convData.targetLanguage
              : convData.sourceLanguage;
          const sourceLanguage =
            tokenType === 'translation' ? convData.sourceLanguage : undefined;

          // Accumulate ALL tokens (both final and non-final), matching frontend display
          // Filter out special "<end>" marker tokens
          if (token.text !== '<end>' && token.text.trim() !== '<end>') {
            if (tokenType === 'original') {
              // Add speaker label when speaker changes (matching frontend logic exactly)
              if (token.speaker && token.speaker !== accumulator.lastOriginalSpeaker) {
                if (accumulator.lastOriginalSpeaker !== null) {
                  accumulator.originalTokens.push('\n\n');
                }
                accumulator.lastOriginalSpeaker = token.speaker;
                accumulator.originalTokens.push(`Speaker ${token.speaker}: `);
              }
              accumulator.originalTokens.push(token.text);
              this.logger.log(
                `Accumulated original token for ${conversationId}: "${token.text.substring(0, 50)}" (speaker: ${token.speaker}, final: ${token.is_final})`,
              );

              // Only accumulate FINAL tokens for database storage with speaker info
              if (token.is_final && token.speaker) {
                const speakerLabel = `Speaker ${token.speaker}`;
                const timestamp = accumulator.recordingStartTime
                  ? Date.now() - accumulator.recordingStartTime.getTime()
                  : 0;
                this.appendFinalSegment(
                  accumulator.finalOriginalSegments,
                  speakerLabel,
                  token.text,
                  timestamp,
                );
                this.logger.log(
                  `Accumulated FINAL original token for ${conversationId}: "${token.text.substring(0, 50)}" (speaker: ${speakerLabel}, timestamp: ${timestamp}ms)`,
                );
              }
            } else {
              // Add speaker label when speaker changes (matching frontend logic exactly)
              if (token.speaker && token.speaker !== accumulator.lastTranslationSpeaker) {
                if (accumulator.lastTranslationSpeaker !== null) {
                  accumulator.translationTokens.push('\n\n');
                }
                accumulator.lastTranslationSpeaker = token.speaker;
                accumulator.translationTokens.push(`Speaker ${token.speaker}: `);
              }
              accumulator.translationTokens.push(token.text);
              this.logger.log(
                `Accumulated translation token for ${conversationId}: "${token.text.substring(0, 50)}" (speaker: ${token.speaker}, final: ${token.is_final})`,
              );

              // Only accumulate FINAL tokens for database storage with speaker info
              if (token.is_final && token.speaker) {
                const speakerLabel = `Speaker ${token.speaker}`;
                const timestamp = accumulator.recordingStartTime
                  ? Date.now() - accumulator.recordingStartTime.getTime()
                  : 0;
                this.appendFinalSegment(
                  accumulator.finalTranslationSegments,
                  speakerLabel,
                  token.text,
                  timestamp,
                );
                this.logger.log(
                  `Accumulated FINAL translation token for ${conversationId}: "${token.text.substring(0, 50)}" (speaker: ${speakerLabel}, timestamp: ${timestamp}ms)`,
                );
              }
            }
          }

          // Extract detected source language from Soniox if available
          // (accumulator is guaranteed non-null at this point)
          if (
            message.detected_language &&
            !accumulator.sourceLanguage &&
            tokenType === 'original'
          ) {
            accumulator.sourceLanguage = message.detected_language;
            convData.sourceLanguage = message.detected_language;
            this.logger.log(
              `Detected source language for ${conversationId}: ${message.detected_language}`,
            );
          }

          const result: TranslationResultDto = {
            text: token.text,
            type: tokenType,
            language: tokenLanguage,
            sourceLanguage,
            timestamp: new Date(),
            isFinal: token.is_final || false,
            speaker: token.speaker,
          };

          // Emit to client
          resultSubject.next(result);
        }
      }
    }

    // Session finished
    if (message.finished) {
      this.logger.debug(
        `Soniox session finished for conversation: ${conversationId}`,
      );
      resultSubject.complete();
    }
  }

  /**
   * Start recording session - tracks when user actually starts recording
   */
  startRecordingSession(conversationId: string): void {
    const accumulator = this.accumulatedResults.get(conversationId);

    if (!accumulator) {
      this.logger.warn(
        `Cannot start recording: accumulator not found for ${conversationId}`,
      );
      return;
    }

    if (accumulator.isCurrentlyRecording) {
      this.logger.warn(
        `Recording already in progress for ${conversationId}. Ignoring duplicate start.`,
      );
      return;
    }

    const recordingStartTime = new Date();
    accumulator.recordingStartTime = recordingStartTime;
    accumulator.isCurrentlyRecording = true;
    accumulator.recordingSegments.push({
      startTime: recordingStartTime,
      endTime: null,
    });

    this.logger.log(
      `Recording started for conversation ${conversationId} at ${recordingStartTime.toISOString()}`,
    );
  }

  /**
   * Stop recording session - accumulates recording time and sets isRecording to false
   */
  stopRecordingSession(conversationId: string): void {
    const accumulator = this.accumulatedResults.get(conversationId);

    if (!accumulator) {
      this.logger.warn(
        `Cannot stop recording: accumulator not found for ${conversationId}`,
      );
      return;
    }

    if (!accumulator.isCurrentlyRecording || !accumulator.recordingStartTime) {
      this.logger.warn(
        `Recording not in progress for ${conversationId}. Ignoring stop.`,
      );
      return;
    }

    const recordingEndTime = new Date();
    const segmentDuration =
      recordingEndTime.getTime() - accumulator.recordingStartTime.getTime();

    // Accumulate the duration and close the current segment
    accumulator.totalRecordingDurationMs += segmentDuration;
    accumulator.isCurrentlyRecording = false;

    // Update the last segment's end time
    const lastSegment = accumulator.recordingSegments[
      accumulator.recordingSegments.length - 1
    ];
    if (lastSegment) {
      lastSegment.endTime = recordingEndTime;
    }

    accumulator.recordingStartTime = null;

    this.logger.log(
      `Recording stopped for conversation ${conversationId}. Segment duration: ${segmentDuration}ms. Total recording duration: ${accumulator.totalRecordingDurationMs}ms`,
    );
  }

  /**
   * Get current recording duration (including in-progress segment)
   */
  getRecordingDuration(conversationId: string): number {
    const accumulator = this.accumulatedResults.get(conversationId);

    if (!accumulator) {
      return 0;
    }

    let totalDuration = accumulator.totalRecordingDurationMs;

    // If currently recording, add the duration of the current segment
    if (accumulator.isCurrentlyRecording && accumulator.recordingStartTime) {
      const currentSegmentDuration =
        Date.now() - accumulator.recordingStartTime.getTime();
      totalDuration += currentSegmentDuration;
    }

    return totalDuration;
  }

  /**
   * Get accumulated results for a conversation
   * Returns both results and error/data status flags
   */
  getConversationResults(conversationId: string) {
    const accumulator = this.accumulatedResults.get(conversationId);

    if (!accumulator) {
      this.logger.error(
        `CRITICAL: No accumulator found for ${conversationId}. This indicates data loss! Returning empty results.`,
      );
      return {
        transcriptionResult: '',
        translationResult: '',
        transcriptionResultJson: '[]',
        translationResultJson: '[]',
        durationInMs: 0,
        targetLanguage: '',
        sourceLanguage: undefined,
        vocabularies: null,
        hasReceivedData: false,
        hasError: false,
      };
    }

    // Use recording-based duration if recording was tracked, otherwise use connection time
    let durationInMs = accumulator.totalRecordingDurationMs;

    // If no recording sessions exist, fall back to connection duration (for backward compatibility)
    if (accumulator.recordingSegments.length === 0) {
      durationInMs = Date.now() - accumulator.startTime.getTime();
    }

    // Log results summary for debugging
    this.logger.log(
      `Results for conversation ${conversationId}: ${accumulator.originalTokens.length} original tokens, ${accumulator.translationTokens.length} translation tokens. ${accumulator.finalOriginalSegments.length} final original segments, ${accumulator.finalTranslationSegments.length} final translation segments. hasError=${accumulator.hasError}, hasReceivedData=${accumulator.hasReceivedData}. Duration: ${durationInMs}ms (recording-based: ${accumulator.recordingSegments.length > 0}, segments: ${accumulator.recordingSegments.length})`,
    );

    return {
      transcriptionResult: accumulator.originalTokens.join(''),
      translationResult: accumulator.translationTokens.join(''),
      transcriptionResultJson: JSON.stringify(accumulator.finalOriginalSegments),
      translationResultJson: JSON.stringify(accumulator.finalTranslationSegments),
      durationInMs,
      targetLanguage: accumulator.targetLanguage,
      sourceLanguage: accumulator.sourceLanguage,
      vocabularies: accumulator.vocabularies,
      hasReceivedData: accumulator.hasReceivedData,
      hasError: accumulator.hasError,
    };
  }

  /**
   * Cleanup accumulated data for a conversation
   */
  cleanupConversation(conversationId: string): void {
    this.accumulatedResults.delete(conversationId);
    this.conversationData.delete(conversationId);
    this.conversationSubjects.delete(conversationId);
    this.logger.debug(`Cleanup completed for conversation: ${conversationId}`);
  }
}
