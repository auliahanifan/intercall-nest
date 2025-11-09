import { HttpException, HttpStatus } from '@nestjs/common';

export interface QuotaExceededData {
  currentPlan: string;
  quotaMinutes?: number;
  usedMinutes?: number;
  upgradeRequired: boolean;
}

export class QuotaExceededException extends HttpException {
  constructor(message: string, public data: QuotaExceededData) {
    super(
      {
        message,
        error: 'QUOTA_EXCEEDED',
        data,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}
