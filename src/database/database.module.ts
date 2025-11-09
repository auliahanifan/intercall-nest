import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DatabaseQueueService } from './database-queue.service';

@Module({
  providers: [PrismaService, DatabaseQueueService],
  exports: [PrismaService, DatabaseQueueService],
})
export class DatabaseModule {}
