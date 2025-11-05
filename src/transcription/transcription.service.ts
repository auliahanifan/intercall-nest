import { Injectable, Logger } from '@nestjs/common';
import { AudioChunkDto, TranslationResultDto } from './dto';
import WebSocket from 'ws';
import { Subject } from 'rxjs';

@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);
  private sonioxConnections = new Map<string, WebSocket>();
  private conversationData = new Map<string, any>();

  constructor() {}

  /**
   * Initialize Soniox connection for a conversation (auto-called on first audio chunk)
   */
  private async initializeSonioxConnection(
    conversationId: string,
    sourceLanguage: string,
    targetLanguage: string,
    resultSubject: Subject<TranslationResultDto>,
  ): Promise<void> {
    try {
      // Initialize Soniox WebSocket connection
      const ws = new WebSocket('wss://api.soniox.com/v1/transcribe');

      ws.on('open', () => {
        this.logger.debug(`Soniox connection opened for conversation: ${conversationId}`);

        // Send initialization message to Soniox
        const initMessage = {
          audio_format: {
            encoding: 'linear16',
            sample_rate_hertz: 16000,
            num_channels: 1,
          },
          language_code: sourceLanguage,
          client_request_uuid: conversationId,
          api_key: process.env.SONIOX_API_KEY,
          translation: {
            type: 'one_way',
            target_language: targetLanguage,
          },
        };

        ws.send(JSON.stringify(initMessage));
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleSonioxMessage(conversationId, message, resultSubject);
        } catch (error) {
          this.logger.error(`Error parsing Soniox message: ${error}`);
          resultSubject.error(error);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`Soniox WebSocket error for conversation ${conversationId}: ${error}`);
        resultSubject.error(error);
      });

      ws.on('close', () => {
        this.logger.debug(`Soniox connection closed for conversation: ${conversationId}`);
        this.sonioxConnections.delete(conversationId);
        this.conversationData.delete(conversationId);
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
    sourceLanguage: string,
    targetLanguage: string,
    dto: AudioChunkDto,
  ): Promise<Subject<TranslationResultDto>> {
    let resultSubject = new Subject<TranslationResultDto>();
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

      // Send audio data to Soniox
      if (ws && ws.readyState === WebSocket.OPEN) {
        const audioMessage = {
          audio: Buffer.from(dto.chunk).toString('base64'),
        };
        ws.send(JSON.stringify(audioMessage));
      } else {
        this.logger.warn(`WebSocket not ready for conversation: ${conversationId}`);
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

    // Check if message contains tokens
    if (message.token) {
      const token = message.token;

      // Determine if this is original or translation
      const tokenType = token.translation_status === 'translation' ? 'translation' : 'original';
      const tokenLanguage = tokenType === 'translation' ? convData.targetLanguage : convData.sourceLanguage;
      const sourceLanguage = tokenType === 'translation' ? convData.sourceLanguage : undefined;

      const result: TranslationResultDto = {
        text: token.text || '',
        type: tokenType,
        language: tokenLanguage,
        sourceLanguage,
        timestamp: new Date(),
      };

      // Emit to client
      resultSubject.next(result);
    }

    // Handle error responses from Soniox
    if (message.error) {
      this.logger.error(`Soniox error: ${message.error}`);
      resultSubject.error(new Error(message.error));
    }
  }
}
