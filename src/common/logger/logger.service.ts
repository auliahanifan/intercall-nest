import { Injectable, LoggerService as ILoggerService } from '@nestjs/common';
import pino from 'pino';

@Injectable()
export class LoggerService implements ILoggerService {
  private logger: pino.Logger;

  constructor() {
    const isDev = process.env.NODE_ENV !== 'production';
    const logLevel = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');
    const betterStackEndpoint = process.env.BETTER_STACK_ENDPOINT;
    const betterStackToken = process.env.BETTER_STACK_TOKEN;

    // Validate Better Stack configuration
    if (!betterStackEndpoint || !betterStackToken) {
      console.warn(
        '[Logger] Better Stack credentials not found. Logs will only be printed locally.',
      );
    }

    // Configure Pino transports
    const targets: pino.TransportTargetOptions[] = [
      {
        target: 'pino-pretty',
        options: {
          colorize: isDev,
          singleLine: false,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    ];

    // Add Better Stack transport if configured
    if (betterStackEndpoint && betterStackToken) {
      targets.push({
        target: '@logtail/pino',
        options: {
          sourceToken: betterStackToken,
          options: {
            endpoint: betterStackEndpoint,
          },
        },
      });
    }

    this.logger = pino(
      {
        level: logLevel,
      },
      pino.transport({
        targets,
      }),
    );
  }

  log(message: string, context?: string) {
    this.logger.info({ context }, message);
  }

  error(message: string, trace?: string, context?: string) {
    this.logger.error({ context, trace }, message);
  }

  warn(message: string, context?: string) {
    this.logger.warn({ context }, message);
  }

  debug(message: string, context?: string) {
    this.logger.debug({ context }, message);
  }

  verbose(message: string, context?: string) {
    this.logger.trace({ context }, message);
  }

  getLogger() {
    return this.logger;
  }
}
