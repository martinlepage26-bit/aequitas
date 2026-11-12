-- A consent or decline binds to one issued party outcome. Re-issuing that
-- outcome revokes the answer. Additive only.

ALTER TABLE "ConsentRecord" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "ConsentRecord" ADD COLUMN "partyOutcomeId" TEXT;
ALTER TABLE "ConsentRecord" ADD COLUMN "partyOutcomeVersion" INTEGER;

ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_partyOutcomeId_fkey"
  FOREIGN KEY ("partyOutcomeId") REFERENCES "PartyOutcome"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ConsentRecord_partyOutcomeId_idx" ON "ConsentRecord"("partyOutcomeId");
