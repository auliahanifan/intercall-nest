import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Database write queue service
 * Defers database operations to a worker queue to prevent blocking socket handlers
 * Uses a simple in-memory queue with configurable concurrency
 */

export interface QueuedDatabaseOperation {
  id: string;
  type: 'create' | 'upsert' | 'update';
  table: 'transcription';
  data: any;
  where?: any;
  priority?: number; // Higher number = higher priority
  retries?: number;
  maxRetries?: number;
  createdAt: Date;
}

@Injectable()
export class DatabaseQueueService {
  private readonly logger = new Logger(DatabaseQueueService.name);
  private queue: QueuedDatabaseOperation[] = [];
  private processing: Set<string> = new Set();
  private maxConcurrency = 3; // Process up to 3 writes concurrently
  private isProcessing = false;

  constructor(private prisma: PrismaService) {
    // Start queue processor immediately
    this.startQueueProcessor();
  }

  /**
   * Enqueue a database operation
   * Returns a promise that resolves when the operation completes
   */
  async enqueue(operation: QueuedDatabaseOperation): Promise<void> {
    operation.retries = operation.retries || 0;
    operation.maxRetries = operation.maxRetries || 3;
    operation.priority = operation.priority || 0;

    this.queue.push(operation);

    // Sort by priority (higher first) then by creation time (FIFO)
    this.queue.sort((a, b) => {
      if (b.priority !== a.priority) {
        return (b.priority || 0) - (a.priority || 0);
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    this.logger.debug(
      `Enqueued ${operation.type} operation for ${operation.table}. Queue size: ${this.queue.length}`
    );
  }

  /**
   * Start the queue processor
   */
  private startQueueProcessor(): void {
    setInterval(() => {
      if (!this.isProcessing) {
        this.processQueue();
      }
    }, 100); // Check queue every 100ms
  }

  /**
   * Process queue items
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (
        this.queue.length > 0 &&
        this.processing.size < this.maxConcurrency
      ) {
        const operation = this.queue.shift();
        if (!operation) break;

        // Prevent duplicate processing
        if (this.processing.has(operation.id)) {
          continue;
        }

        this.processing.add(operation.id);

        // Process asynchronously without awaiting (fire and forget with tracking)
        this.processOperation(operation).then(() => {
          this.processing.delete(operation.id);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single database operation with retry logic
   */
  private async processOperation(
    operation: QueuedDatabaseOperation
  ): Promise<void> {
    try {
      this.logger.debug(
        `Processing ${operation.type} operation on ${operation.table}: ${operation.id}`
      );

      switch (operation.type) {
        case 'create':
          await this.prisma.transcription.create({
            data: operation.data,
          });
          break;

        case 'upsert':
          await this.prisma.transcription.upsert({
            where: operation.where,
            create: operation.data.create,
            update: operation.data.update,
          });
          break;

        case 'update':
          await this.prisma.transcription.update({
            where: operation.where,
            data: operation.data,
          });
          break;
      }

      this.logger.debug(
        `Successfully processed ${operation.type} operation: ${operation.id}`
      );
    } catch (error) {
      operation.retries = (operation.retries || 0) + 1;

      // Determine if error is retryable
      const isRetryableError =
        error.code === 'ECONNREFUSED' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('timeout') ||
        error.message?.includes('connection') ||
        error.message?.includes('deadlock');

      if (
        isRetryableError &&
        operation.retries < (operation.maxRetries || 3)
      ) {
        // Re-enqueue for retry with exponential backoff
        const delayMs = Math.pow(2, operation.retries - 1) * 1000;
        this.logger.warn(
          `Database operation failed (attempt ${operation.retries}): ${error.message}. Retrying in ${delayMs}ms`
        );

        // Add back to queue after delay
        setTimeout(() => {
          this.queue.push(operation);
        }, delayMs);
      } else {
        // Max retries exhausted or non-retryable error
        this.logger.error(
          `Database operation failed permanently after ${operation.retries} attempts: ${operation.id}. Error: ${error.message}`
        );
        // Operation is discarded (don't block audio processing)
      }
    }
  }

  /**
   * Get current queue size (for monitoring)
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Get number of operations being processed
   */
  getProcessingCount(): number {
    return this.processing.size;
  }

  /**
   * Flush the queue and wait for all operations to complete
   * Useful for graceful shutdown
   */
  async flush(): Promise<void> {
    this.logger.log('Flushing database queue...');

    while (this.queue.length > 0 || this.processing.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log('Database queue flushed');
  }
}
