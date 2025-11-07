import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';
import { UserService } from './user.service';
import { OnboardingDto } from './dto';

@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('onboarding')
  async onboarding(
    @Session() session: UserSession,
    @Body() data: OnboardingDto,
  ): Promise<any> {
    // Validate request body
    if (
      !data.hear_from ||
      !data.primary_language ||
      !Array.isArray(data.interpreter_specialty) ||
      data.interpreter_specialty.length === 0
    ) {
      throw new BadRequestException(
        'Missing required fields: hear_from, primary_language, interpreter_specialty (must be non-empty array)',
      );
    }

    // Save onboarding data
    const userDetail = await this.userService.saveOnboarding(
      session.user.id,
      data,
    );

    return {
      success: true,
      message: 'Onboarding completed successfully',
      data: userDetail,
    };
  }
}
