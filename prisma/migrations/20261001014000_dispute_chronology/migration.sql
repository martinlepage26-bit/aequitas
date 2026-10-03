ALTER TYPE "EventType" ADD VALUE 'CHRONOLOGY_ENTRY_SUBMITTED';

CREATE TABLE "ChronologyEntry" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "submittedById" TEXT NOT NULL,
  "occurredOn" DATE NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChronologyEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChronologyEntry_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ChronologyEntry_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ChronologyEntry_caseId_occurredOn_createdAt_idx" ON "ChronologyEntry"("caseId", "occurredOn", "createdAt");

CREATE FUNCTION prevent_chronology_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Chronology entries are append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER chronology_append_only BEFORE UPDATE OR DELETE ON "ChronologyEntry"
FOR EACH ROW EXECUTE FUNCTION prevent_chronology_mutation();
