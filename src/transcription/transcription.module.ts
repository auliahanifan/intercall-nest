import { Module } from '@nestjs/common';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';
import { LoggerModule } from '../common/logger/logger.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [LoggerModule, DatabaseModule],
  controllers: [],
  providers: [TranscriptionGateway, TranscriptionService],
})
export class TranscriptionModule {}
