-- Additive only: existing cases keep a null description and amount.
-- The new event value records successful downloads of clean evidence.
ALTER TABLE "Case" ADD COLUMN "disputeDescription" TEXT;
ALTER TABLE "Case" ADD COLUMN "amountAtStakeCents" INTEGER;

ALTER TYPE "EventType" ADD VALUE 'EVIDENCE_ACCESSED';
