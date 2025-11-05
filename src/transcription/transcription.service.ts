import { Injectable, Logger } from '@nestjs/common';
import { AudioChunkDto, TranslationResultDto } from './dto';
import WebSocket from 'ws';
import { Subject } from 'rxjs';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private sonioxConnections = new Map<string, WebSocket>();
  private conversationData = new Map<string, any>();
  private conversationSubjects = new Map<
    string,
    Subject<TranslationResultDto>
  >();

  constructor() {}

  /**
   * Initialize Soniox connection for a conversation (auto-called on first audio chunk)
   */
  private async initializeSonioxConnection(
    conversationId: string,
    sourceLanguage: string | null,
    targetLanguage: string,
    resultSubject: Subject<TranslationResultDto>,
  ): Promise<void> {
    try {
      // Initialize Soniox WebSocket connection
      const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');

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

        if (sourceLanguage) {
          config.language_hints = [sourceLanguage];
        }

        ws.send(JSON.stringify(config));
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
      });

      ws.on('close', () => {
        this.logger.debug(
          `Soniox connection closed for conversation: ${conversationId}`,
        );
        this.sonioxConnections.delete(conversationId);
        this.conversationData.delete(conversationId);
        this.conversationSubjects.delete(conversationId);
        resultSubject.complete();
      });

      // Store the WebSocket connection
      this.sonioxConnections.set(conversationId, ws);
    } catch (error) {
      this.logger.error(`Failed to initialize Soniox connection: ${error}`);
      resultSubject.error(error);
    }
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

    let ws = this.sonioxConnections.get(conversationId);

    try {
      // Auto-initialize on first chunk
      if (!ws) {
        this.logger.log(
          `First audio chunk for conversation ${conversationId}, initializing Soniox`,
        );

        // Store conversation metadata
        this.conversationData.set(conversationId, {
          sourceLanguage,
          targetLanguage,
        });

        // Initialize Soniox connection
        await this.initializeSonioxConnection(
          conversationId,
          sourceLanguage,
          targetLanguage,
          resultSubject,
        );

        ws = this.sonioxConnections.get(conversationId);
      }

      // Send audio data to Soniox (raw binary)
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else {
        this.logger.warn(
          `WebSocket not ready for conversation: ${conversationId}`,
        );
      }

      return resultSubject;
    } catch (error) {
      this.logger.error(`Error processing audio chunk: ${error}`);
      resultSubject.error(error);
      return resultSubject;
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

    if (!convData) {
      this.logger.warn(`Conversation data not found: ${conversationId}`);
      return;
    }

    // Handle error responses from Soniox
    if (message.error_code) {
      this.logger.error(
        `Soniox error: ${message.error_code} - ${message.error_message}`,
      );
      resultSubject.error(new Error(message.error_message));
      return;
    }

    // Process tokens array
    if (message.tokens && Array.isArray(message.tokens)) {
      for (const token of message.tokens) {
        if (token.text) {
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
}
