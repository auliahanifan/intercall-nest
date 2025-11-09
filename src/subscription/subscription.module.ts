import { Module } from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { SubscriptionController } from './subscription.controller';
import { QuotaGuard } from './guards/quota.guard';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [SubscriptionService, QuotaGuard],
  controllers: [SubscriptionController],
  exports: [SubscriptionService, QuotaGuard],
})
export class SubscriptionModule {}
