-- Complete the typed, bounded Evaluation Definition contract without rewriting
-- existing published evidence, then make its audit trail append-only.
ALTER TABLE evaluation_definition_drafts
    ADD COLUMN IF NOT EXISTS sampling JSONB NOT NULL DEFAULT '{"strategy":"first_n","sample_size":100,"seed":0}'::jsonb,
    ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{"max_cost_usd":10,"max_duration_seconds":3600}'::jsonb;
ALTER TABLE evaluation_definition_versions
    ADD COLUMN IF NOT EXISTS sampling JSONB NOT NULL DEFAULT '{"strategy":"first_n","sample_size":100,"seed":0}'::jsonb,
    ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL DEFAULT '{"max_cost_usd":10,"max_duration_seconds":3600}'::jsonb;

UPDATE evaluation_definition_drafts
SET evaluator = evaluator || '{"version":"v1"}'::jsonb
WHERE NOT evaluator ? 'version';

CREATE OR REPLACE FUNCTION prevent_evaluation_audit_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        PERFORM lock_project_audit_provenance(OLD.project_id);
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'evaluation audit events are append-only' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS evaluation_audit_events_provenance ON evaluation_audit_events;
CREATE TRIGGER evaluation_audit_events_provenance
BEFORE INSERT ON evaluation_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_retained_audit_project_provenance();
DROP TRIGGER IF EXISTS evaluation_audit_events_immutable ON evaluation_audit_events;
CREATE TRIGGER evaluation_audit_events_immutable
BEFORE UPDATE OR DELETE ON evaluation_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_evaluation_audit_event_mutation();
