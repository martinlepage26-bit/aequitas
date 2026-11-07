-- Fair retries and exclusive scheduled work claims for opted-in cases.
ALTER TABLE "Case"
  ADD COLUMN "agentLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "agentNextRunAt" TIMESTAMP(3),
  ADD COLUMN "agentLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "agentLeaseToken" TEXT;

UPDATE "Case" SET "agentNextRunAt" = "createdAt"
  WHERE "agentManaged" = true AND "agentNextRunAt" IS NULL;

CREATE INDEX "Case_agentManaged_agentEscalatedAt_agentNextRunAt_agentLeaseUntil_agentLastAttemptAt_createdAt_idx"
  ON "Case"("agentManaged", "agentEscalatedAt", "agentNextRunAt", "agentLeaseUntil", "agentLastAttemptAt", "createdAt");
