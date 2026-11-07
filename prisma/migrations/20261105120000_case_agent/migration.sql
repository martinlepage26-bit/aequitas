-- Prototype automated case agent. Additive only.
-- CASE_AGENT is a service role: no session is ever issued for it
-- (src/lib/session.ts accepts only the four human roles).
ALTER TYPE "GlobalRole" ADD VALUE 'CASE_AGENT';
ALTER TYPE "EventType" ADD VALUE 'AGENT_ENROLLED';
ALTER TYPE "EventType" ADD VALUE 'AGENT_ESCALATED';

ALTER TABLE "Case" ADD COLUMN "agentManaged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Case" ADD COLUMN "agentEscalatedAt" TIMESTAMP(3);
ALTER TABLE "Case" ADD COLUMN "agentEscalationReason" TEXT;
