import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  constructor(private logger: LoggerService) {}

  use(req: any, res: Response, next: NextFunction) {
    const startTime = Date.now();
    const requestId = req.get('x-request-id') || this.generateRequestId();

    // Capture request details
    const requestDetails = {
      requestId,
      method: req.method,
      path: req.path,
      query: req.query,
      headers: this.filterSensitiveHeaders(req.headers),
      body: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      userId: req.user ? req.user.id : undefined,
      sessionId: req.sessionID,
    };

    // Log incoming request
    this.logger.log(
      `Incoming ${req.method} ${req.path}`,
      'HttpLogger',
    );
    this.logger.debug(
      `Request details: ${JSON.stringify(requestDetails)}`,
      'HttpLogger',
    );

    // Capture original response methods
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    let responseBody: any;

    // Override response methods to capture response body
    res.json = (data: any) => {
      responseBody = data;
      return originalJson(data);
    };

    res.send = (data: any) => {
      if (typeof data === 'object') {
        responseBody = data;
      } else {
        responseBody = data ? { body: data.toString() } : undefined;
      }
      return originalSend(data);
    };

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - startTime;

      const responseDetails = {
        requestId,
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        duration: `${duration}ms`,
        headers: this.filterSensitiveHeaders(res.getHeaders()),
        body: responseBody,
      };

      const logLevel =
        res.statusCode >= 500
          ? 'error'
          : res.statusCode >= 400
            ? 'warn'
            : 'log';

      this.logger[logLevel](
        `Outgoing ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`,
        'HttpLogger',
      );
      this.logger.debug(
        `Response details: ${JSON.stringify(responseDetails)}`,
        'HttpLogger',
      );
    });

    next();
  }

  private filterSensitiveHeaders(headers: any): any {
    if (!headers) return {};

    const sensitiveKeys = [
      'authorization',
      'cookie',
      'x-auth-token',
      'x-access-token',
      'x-api-key',
      'password',
    ];

    const filtered = { ...headers };
    sensitiveKeys.forEach((key) => {
      if (filtered[key]) {
        filtered[key] = '[REDACTED]';
      }
    });

    return filtered;
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
