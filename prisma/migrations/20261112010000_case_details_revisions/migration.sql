-- Future corrections retain their source snapshots outside immutable events.
-- No historical events or case data are changed by this migration.
CREATE TABLE "CaseDetailsRevision" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "nonce" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseDetailsRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseDetailsRevision_caseId_createdAt_idx"
    ON "CaseDetailsRevision"("caseId", "createdAt");

ALTER TABLE "CaseDetailsRevision" ADD CONSTRAINT "CaseDetailsRevision_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
