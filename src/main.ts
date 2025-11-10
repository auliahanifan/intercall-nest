import dotenv from 'dotenv';

dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { LoggerService } from './common/logger/logger.service';
import { PrismaClient } from 'generated/prisma/client';

/**
 * Validates that required subscription plans exist in the database
 */
async function validateSubscriptionPlans() {
  const prisma = new PrismaClient();

  try {
    const freePlan = await prisma.subscriptionPlan.findUnique({
      where: { slug: 'free' },
    });

    if (!freePlan) {
      console.error(
        `\n[STARTUP ERROR] Free subscription plan not found in database!\n` +
          `This is required for auto-organization creation to work properly.\n` +
          `Please ensure the following record exists in the 'SubscriptionPlan' table:\n` +
          `- slug: 'free'\n` +
          `- name: 'Free'\n` +
          `- description: 'Free tier with limited features'\n` +
          `- quotaMinutes: 60 (or your desired limit)\n` +
          `- quotaResetsMonthly: true\n` +
          `- price: 0\n` +
          `- currency: 'USD'\n` +
          `- isActive: true\n\n`,
      );
    } else {
      console.log('[Startup] Free subscription plan verified ✓', {
        planId: freePlan.id,
        planName: freePlan.name,
        quotaMinutes: freePlan.quotaMinutes,
      });
    }
  } catch (error) {
    console.error('[Startup] Error validating subscription plans:', error);
  } finally {
    await prisma.$disconnect();
  }
}

async function bootstrap() {
  // Validate subscription plans before starting
  await validateSubscriptionPlans();

  const app = await NestFactory.create(AppModule, {
    bodyParser: false, // Required for Better Auth
  });

  const logger = new LoggerService();
  app.useLogger(logger);

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
  logger.log(
    `Server running on 0.0.0.0:${process.env.PORT ?? 3000}`,
    'Bootstrap',
  );
}
bootstrap();
