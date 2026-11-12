-- Parties control when evidence intake is complete on an opted-in case.
ALTER TYPE "EventType" ADD VALUE 'PARTY_INTAKE_READY_MARKED';
ALTER TYPE "EventType" ADD VALUE 'PARTY_INTAKE_READY_CLEARED';

ALTER TABLE "Case" ADD COLUMN "complainantIntakeReadyAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN "respondentIntakeReadyAt" TIMESTAMP(3);
