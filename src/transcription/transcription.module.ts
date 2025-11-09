import { Module } from '@nestjs/common';
import { TranscriptionGateway } from './transcription.gateway';
import { TranscriptionService } from './transcription.service';
import { LoggerModule } from '../common/logger/logger.module';
import { DatabaseModule } from '../database/database.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [LoggerModule, DatabaseModule, SubscriptionModule],
  controllers: [],
  providers: [TranscriptionGateway, TranscriptionService],
})
export class TranscriptionModule {}
