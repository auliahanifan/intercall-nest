import { Controller, Get } from '@nestjs/common';
import { Session, UserSession } from '@thallesp/nestjs-better-auth';
import { SubscriptionService } from './subscription.service';

@Controller('api/subscriptions')
export class SubscriptionController {
  constructor(private subscriptionService: SubscriptionService) {}

  @Get('current')
  async getCurrentSubscription(@Session() session: UserSession) {
    const organizationId = (session.user as any).activeOrganizationId;

    if (!organizationId) {
      throw new Error('No active organization found in session');
    }

    return this.subscriptionService.getCurrentSubscription(organizationId);
  }

  @Get('plans')
  async getAvailablePlans() {
    return this.subscriptionService.getAvailablePlans();
  }

  @Get('usage')
  async getUsageHistory(@Session() session: UserSession) {
    const organizationId = (session.user as any).activeOrganizationId;

    if (!organizationId) {
      throw new Error('No active organization found in session');
    }

    return this.subscriptionService.getUsageHistory(organizationId);
  }
}
