import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';

const prisma = new PrismaClient() as any;

async function main() {
  console.log('Migrating price data to normalPrice...');

  // Copy existing price values to normalPrice
  const plans = await prisma.subscriptionPlan.findMany();

  for (const plan of plans) {
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: {
        normalPrice: plan.price,
      },
    });
    console.log(`✓ Migrated ${plan.name}: price ${plan.price} -> normalPrice ${plan.price}`);
  }

  console.log('✅ Price migration completed successfully');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
