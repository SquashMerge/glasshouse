CREATE OR REPLACE FUNCTION prevent_project_lifecycle_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'project lifecycle audit events are append-only'
        USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS project_lifecycle_audit_events_immutable
    ON project_lifecycle_audit_events;
CREATE TRIGGER project_lifecycle_audit_events_immutable
BEFORE UPDATE OR DELETE ON project_lifecycle_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_project_lifecycle_audit_mutation();
