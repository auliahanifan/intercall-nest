import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient() as any;

async function main() {
  console.log('Starting seed...');

  // Create subscription plans
  const plans = [
    {
      name: 'Free',
      slug: 'free',
      description: '60 minutes lifetime quota',
      normalPrice: 0,
      promoPrice: null,
      isPromo: false,
      paymentLink: null,
      currency: 'USD',
      quotaMinutes: 60,
      quotaResetsMonthly: false,
      features: {
        maxVocabularies: 5,
        supportLevel: 'community',
      },
      isActive: true,
    },
    {
      name: 'Pro',
      slug: 'pro',
      description: '500 minutes per month',
      normalPrice: 2900, // $29.00
      promoPrice: null,
      isPromo: false,
      paymentLink: null,
      currency: 'USD',
      quotaMinutes: 500,
      quotaResetsMonthly: true,
      features: {
        maxVocabularies: 50,
        supportLevel: 'email',
        prioritySupport: true,
      },
      isActive: true,
    },
    {
      name: 'Enterprise',
      slug: 'enterprise',
      description: 'Unlimited usage with custom support',
      normalPrice: 0, // Custom pricing
      promoPrice: null,
      isPromo: false,
      paymentLink: null,
      currency: 'USD',
      quotaMinutes: 999999, // Effectively unlimited
      quotaResetsMonthly: true,
      features: {
        unlimited: true,
        supportLevel: 'dedicated',
        dedicatedSupport: true,
        customIntegrations: true,
      },
      isActive: true,
    },
  ];

  // Upsert subscription plans
  for (const plan of plans) {
    const created = await prisma.subscriptionPlan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        normalPrice: plan.normalPrice,
        promoPrice: plan.promoPrice,
        isPromo: plan.isPromo,
        paymentLink: plan.paymentLink,
        currency: plan.currency,
        quotaMinutes: plan.quotaMinutes,
        quotaResetsMonthly: plan.quotaResetsMonthly,
        features: plan.features as any,
        isActive: plan.isActive,
      },
      create: plan,
    });
    console.log(`✓ Created/updated plan: ${created.name}`);
  }

  // Get free plan for existing organizations
  const freePlan = await prisma.subscriptionPlan.findUnique({
    where: { slug: 'free' },
  });

  if (!freePlan) {
    throw new Error('Free plan not found');
  }

  // Create subscriptions for organizations without one
  const organizationsWithoutSubscription =
    await prisma.organization.findMany({
      where: {
        subscription: null,
      },
    });

  for (const org of organizationsWithoutSubscription) {
    // Calculate lifetime usage from existing transcriptions
    const usageResult = await prisma.transcription.aggregate({
      where: { organizationId: org.id },
      _sum: { durationInMs: true },
    });

    const lifetimeUsageMinutes =
      (usageResult._sum.durationInMs || 0n) / 60000n;

    const subscription = await prisma.organizationSubscription.create({
      data: {
        organizationId: org.id,
        planId: freePlan.id,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: null, // Never expires for free tier
        lifetimeUsageMinutes: Number(lifetimeUsageMinutes),
      },
    });
    console.log(
      `✓ Created subscription for organization: ${org.name} (${subscription.id})`,
    );
  }

  console.log('✅ Seed completed successfully');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
