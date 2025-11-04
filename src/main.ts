import dotenv from 'dotenv';

dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LoggerService } from './common/logger/logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // Required for Better Auth
  });

  const logger = new LoggerService();
  app.useLogger(logger);

  await app.listen(process.env.PORT ?? 3000);
  logger.log(`Server running on port ${process.env.PORT ?? 3000}`, 'Bootstrap');
}
bootstrap();
