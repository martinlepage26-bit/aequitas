-- Record each party's affirmative choice before any case material is sent
-- to the configured case-agent provider. The append-only Event log remains
-- the audit source; the event payload stores only the reviewed notice and
-- provider/prompt identity, never party submissions.
ALTER TYPE "EventType" ADD VALUE 'AGENT_PROCESSING_ACCEPTED';
