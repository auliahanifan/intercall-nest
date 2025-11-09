import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { QuotaExceededException } from './exceptions/quota-exceeded.exception';

interface QuotaCheckResult {
  allowed: boolean;
  remainingMinutes: number;
  usedMinutes: number;
  quotaMinutes: number;
  planName: string;
  message?: string;
}

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Check if an organization has quota available
   */
  async checkQuotaAvailability(organizationId: string): Promise<QuotaCheckResult> {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: {
        plan: true,
      },
    });

    if (!subscription) {
      throw new Error(`No subscription found for organization ${organizationId}`);
    }

    if (subscription.status !== 'active') {
      throw new QuotaExceededException(
        `Subscription is ${subscription.status}`,
        {
          currentPlan: subscription.plan.name,
          upgradeRequired: true,
        },
      );
    }

    const quotaMinutes = subscription.plan.quotaMinutes;
    let usedMinutes = 0;

    // Calculate used minutes based on quota reset setting
    if (!subscription.plan.quotaResetsMonthly) {
      // Lifetime quota
      usedMinutes = subscription.lifetimeUsageMinutes;
    } else {
      // Monthly quota - check current period
      const now = new Date();
      let currentPeriod = await this.prisma.usagePeriod.findFirst({
        where: {
          subscriptionId: subscription.id,
          periodStart: { lte: now },
          periodEnd: { gte: now },
        },
      });

      // If no current period or period expired, create a new one
      if (!currentPeriod) {
        currentPeriod = await this.getOrCreateCurrentPeriod(subscription);
      }

      usedMinutes = currentPeriod.usageMinutes;
    }

    const remainingMinutes = quotaMinutes - usedMinutes;
    const allowed = remainingMinutes > 0;

    if (!allowed) {
      throw new QuotaExceededException(
        `Quota exceeded for plan ${subscription.plan.name}`,
        {
          currentPlan: subscription.plan.name,
          quotaMinutes,
          usedMinutes,
          upgradeRequired: true,
        },
      );
    }

    return {
      allowed,
      remainingMinutes,
      usedMinutes,
      quotaMinutes,
      planName: subscription.plan.name,
    };
  }

  /**
   * Record usage after a transcription session
   */
  async recordUsage(organizationId: string, durationMs: bigint): Promise<void> {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: {
        plan: true,
      },
    });

    if (!subscription) {
      throw new Error(`No subscription found for organization ${organizationId}`);
    }

    const durationMinutes = Number(durationMs) / 60000;

    if (!subscription.plan.quotaResetsMonthly) {
      // Update lifetime usage
      await this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          lifetimeUsageMinutes: {
            increment: durationMinutes,
          },
        },
      });
    } else {
      // Update current period usage
      const now = new Date();
      let currentPeriod = await this.prisma.usagePeriod.findFirst({
        where: {
          subscriptionId: subscription.id,
          periodStart: { lte: now },
          periodEnd: { gte: now },
        },
      });

      // If no current period, create one
      if (!currentPeriod) {
        currentPeriod = await this.getOrCreateCurrentPeriod(subscription);
      }

      await this.prisma.usagePeriod.update({
        where: { id: currentPeriod.id },
        data: {
          usageMinutes: {
            increment: durationMinutes,
          },
        },
      });
    }
  }

  /**
   * Get current subscription with usage information
   */
  async getCurrentSubscription(organizationId: string) {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: {
        plan: true,
        usagePeriods: {
          orderBy: { periodStart: 'desc' },
          take: 1,
        },
      },
    });

    if (!subscription) {
      throw new Error(`No subscription found for organization ${organizationId}`);
    }

    const quotaMinutes = subscription.plan.quotaMinutes;
    let usedMinutes = 0;
    let periodEnd = null;

    if (!subscription.plan.quotaResetsMonthly) {
      usedMinutes = subscription.lifetimeUsageMinutes;
    } else {
      const currentPeriod = subscription.usagePeriods?.[0];
      if (currentPeriod) {
        usedMinutes = currentPeriod.usageMinutes;
        periodEnd = currentPeriod.periodEnd;
      }
    }

    const remainingMinutes = Math.max(0, quotaMinutes - usedMinutes);
    const percentageUsed = (usedMinutes / quotaMinutes) * 100;

    return {
      subscription: {
        id: subscription.id,
        plan: {
          name: subscription.plan.name,
          slug: subscription.plan.slug,
          quotaMinutes: subscription.plan.quotaMinutes,
          quotaResetsMonthly: subscription.plan.quotaResetsMonthly,
          normalPrice: subscription.plan.normalPrice,
          promoPrice: subscription.plan.promoPrice,
          isPromo: subscription.plan.isPromo,
          paymentLink: subscription.plan.paymentLink,
          currency: subscription.plan.currency,
        },
        status: subscription.status,
      },
      usage: {
        usedMinutes: Math.round(usedMinutes * 100) / 100,
        remainingMinutes: Math.round(remainingMinutes * 100) / 100,
        quotaMinutes,
        percentageUsed: Math.round(percentageUsed * 100) / 100,
        periodEnd,
      },
    };
  }

  /**
   * Get all available plans
   */
  async getAvailablePlans() {
    return this.prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  /**
   * Get usage history for an organization
   */
  async getUsageHistory(organizationId: string, limit: number = 30) {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
    });

    if (!subscription) {
      throw new Error(`No subscription found for organization ${organizationId}`);
    }

    // Get transcriptions for the organization
    const transcriptions = await this.prisma.transcription.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        durationInMs: true,
        targetLanguage: true,
        sourceLanguage: true,
      },
    });

    return transcriptions.map((t) => ({
      id: t.id,
      date: t.createdAt,
      durationMinutes: Math.round((Number(t.durationInMs) / 60000) * 100) / 100,
      sourceLanguage: t.sourceLanguage,
      targetLanguage: t.targetLanguage,
    }));
  }

  /**
   * Private helper: Get or create current usage period
   */
  private async getOrCreateCurrentPeriod(subscription: any) {
    const now = new Date();
    const periodStart = subscription.currentPeriodStart;
    let periodEnd = subscription.currentPeriodEnd;

    // If current period has expired, calculate new period dates
    if (periodEnd && now > periodEnd) {
      // Calculate next period
      const daysDiff = Math.floor(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24),
      );
      periodStart.setDate(periodStart.getDate() + daysDiff);
      periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 1);

      // Update subscription with new period dates
      await this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });
    }

    // Find or create usage period
    let usagePeriod = await this.prisma.usagePeriod.findFirst({
      where: {
        subscriptionId: subscription.id,
        periodStart,
      },
    });

    if (!usagePeriod) {
      usagePeriod = await this.prisma.usagePeriod.create({
        data: {
          subscriptionId: subscription.id,
          periodStart,
          periodEnd: periodEnd || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now if not set
          usageMinutes: 0,
        },
      });
    }

    return usagePeriod;
  }
}
