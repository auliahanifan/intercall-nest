-- Add missing columns to subscription_plan if they don't exist
ALTER TABLE "subscription_plan" ADD COLUMN IF NOT EXISTS "normalPrice" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plan" ADD COLUMN IF NOT EXISTS "promoPrice" INTEGER;
ALTER TABLE "subscription_plan" ADD COLUMN IF NOT EXISTS "isPromo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plan" ADD COLUMN IF NOT EXISTS "paymentLink" TEXT;

-- Create the TranscriptionStatus enum type
CREATE TYPE "TranscriptionStatus" AS ENUM ('COMPLETED', 'NO_DATA', 'FAILED', 'IN_PROGRESS');

-- Add status column to transcription table and make result fields nullable
ALTER TABLE "transcription" ADD COLUMN "status" "TranscriptionStatus" NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "transcription" ALTER COLUMN "targetLanguage" DROP NOT NULL;
ALTER TABLE "transcription" ALTER COLUMN "transcriptionResult" DROP NOT NULL;
ALTER TABLE "transcription" ALTER COLUMN "translationResult" DROP NOT NULL;
