-- Guardrail 2 (aequitas-implementation-handoff.md): "The event log is
-- append-only. Enforce at the database level with a trigger that raises on
-- UPDATE/DELETE of the `events` table. No application code path may
-- attempt it."

CREATE OR REPLACE FUNCTION prevent_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Event table is append-only: % is not permitted on case %, seq %',
    TG_OP, OLD."caseId", OLD.seq;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_append_only
BEFORE UPDATE OR DELETE ON "Event"
FOR EACH ROW
EXECUTE FUNCTION prevent_event_mutation();
