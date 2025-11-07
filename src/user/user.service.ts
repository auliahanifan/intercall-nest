import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OnboardingDto } from './dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly prisma: PrismaService) {}

  async saveOnboarding(userId: string, data: OnboardingDto): Promise<any> {
    this.logger.log(`Saving onboarding data for user ${userId}`, {
      userId,
      hear_from: data.hear_from,
      primary_language: data.primary_language,
      interpreter_specialty: data.interpreter_specialty,
    });

    try {
      const userDetail = await this.prisma.userDetail.upsert({
        where: { userId },
        update: {
          hasCompletedOnboarding: true,
          onboardingAnswers: {
            hear_from: data.hear_from,
            primary_language: data.primary_language,
            interpreter_specialty: data.interpreter_specialty,
          },
          updatedAt: new Date(),
        },
        create: {
          userId,
          hasCompletedOnboarding: true,
          onboardingAnswers: {
            hear_from: data.hear_from,
            primary_language: data.primary_language,
            interpreter_specialty: data.interpreter_specialty,
          },
        },
      });

      this.logger.log(`Successfully saved onboarding for user ${userId}`);
      return userDetail;
    } catch (error) {
      this.logger.error(`Failed to save onboarding for user ${userId}`, error);
      throw error;
    }
  }
}
