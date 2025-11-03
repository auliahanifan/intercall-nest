import { Module } from '@nestjs/common';
import { TranscriptionGateway } from './transcription.gateway';

@Module({
  imports: [],
  controllers: [],
  providers: [TranscriptionGateway],
})
export class TranscriptionModule {}
