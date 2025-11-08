-- CreateTable
CREATE TABLE "transcription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "durationInMs" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "vocabularies" JSONB,
    "modelName" TEXT NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "transcriptionResult" TEXT NOT NULL,
    "translationResult" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transcription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transcription_organizationId_idx" ON "transcription"("organizationId");

-- AddForeignKey
ALTER TABLE "transcription" ADD CONSTRAINT "transcription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
