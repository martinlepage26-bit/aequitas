-- The case-agent flag alone must not silently waive the independent review
-- introduced in Phase 3. Persist the program's explicit resolution choice
-- on each enrolled case so escalation can restore human approval.
ALTER TABLE "Case" ADD COLUMN "agentConsentOnlyResolution" BOOLEAN NOT NULL DEFAULT false;
