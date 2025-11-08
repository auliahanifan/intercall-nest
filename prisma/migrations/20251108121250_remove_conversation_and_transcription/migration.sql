/*
  Warnings:

  - You are about to drop the `conversation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `transcription` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."conversation" DROP CONSTRAINT "conversation_userId_fkey";

-- DropForeignKey
ALTER TABLE "public"."transcription" DROP CONSTRAINT "transcription_conversationId_fkey";

-- DropTable
DROP TABLE "public"."conversation";

-- DropTable
DROP TABLE "public"."transcription";
