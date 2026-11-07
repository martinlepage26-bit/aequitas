-- Keep exact citation pointers on the outcome version the party receives.
-- The excerpt stays in source storage and is verified on demand.
CREATE TABLE "PartyOutcomeCitation" (
  "id" TEXT NOT NULL,
  "partyOutcomeId" TEXT NOT NULL,
  "evidenceItemId" TEXT NOT NULL,
  "relevance" TEXT NOT NULL,
  "startChar" INTEGER NOT NULL,
  "endChar" INTEGER NOT NULL,
  "sourceSha256" TEXT NOT NULL,
  "extractedTextSha256" TEXT NOT NULL,
  "extractionMethod" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartyOutcomeCitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PartyOutcomeCitation_partyOutcomeId_evidenceItemId_key"
  ON "PartyOutcomeCitation"("partyOutcomeId", "evidenceItemId");
CREATE INDEX "PartyOutcomeCitation_evidenceItemId_idx"
  ON "PartyOutcomeCitation"("evidenceItemId");

ALTER TABLE "PartyOutcomeCitation"
  ADD CONSTRAINT "PartyOutcomeCitation_partyOutcomeId_fkey"
  FOREIGN KEY ("partyOutcomeId") REFERENCES "PartyOutcome"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartyOutcomeCitation"
  ADD CONSTRAINT "PartyOutcomeCitation_evidenceItemId_fkey"
  FOREIGN KEY ("evidenceItemId") REFERENCES "EvidenceItem"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
