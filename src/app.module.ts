import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './lib/auth';
import { TranscriptionModule } from './transcription/transcription.module';

@Module({
  imports: [AuthModule.forRoot({ auth }), TranscriptionModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
