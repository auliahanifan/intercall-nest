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
      !data.interpreter_specialty
    ) {
      throw new BadRequestException(
        'Missing required fields: hear_from, primary_language, interpreter_specialty',
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
