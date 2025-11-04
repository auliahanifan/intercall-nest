import { Module } from '@nestjs/common';
import { TranscriptionGateway } from './transcription.gateway';
import { LoggerModule } from '../common/logger/logger.module';

@Module({
  imports: [LoggerModule],
  controllers: [],
  providers: [TranscriptionGateway],
})
export class TranscriptionModule {}
