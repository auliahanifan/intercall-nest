import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { SubscriptionService } from '../subscription.service';
import { QuotaExceededException } from '../exceptions/quota-exceeded.exception';

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private subscriptionService: SubscriptionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const socket = context.switchToWs().getClient();

    // Extract organizationId from the socket
    const organizationId = (socket as any).activeOrganizationId;

    if (!organizationId) {
      throw new Error('No active organization found in session');
    }

    // Check quota availability
    try {
      const quotaResult = await this.subscriptionService.checkQuotaAvailability(
        organizationId,
      );

      // Attach quota information to socket for later use
      socket.quotaResult = quotaResult;

      return quotaResult.allowed;
    } catch (error) {
      if (error instanceof QuotaExceededException) {
        throw error;
      }
      throw new Error(`Failed to check quota: ${error.message}`);
    }
  }
}
