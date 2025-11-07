-- CreateTable
CREATE TABLE "user_detail" (
    "userId" TEXT NOT NULL,
    "hasCompletedOnboarding" BOOLEAN NOT NULL DEFAULT false,
    "onboardingAnswers" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_detail_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "user_detail" ADD CONSTRAINT "user_detail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
