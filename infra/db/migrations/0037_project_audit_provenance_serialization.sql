-- A UUID hash collision can only serialize unrelated projects; it cannot let
-- provenance checks proceed concurrently for the same UUID.
CREATE OR REPLACE FUNCTION lock_project_audit_provenance(project_uuid UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(project_uuid::text, 0));
END
$$;

CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_project_audit_provenance(NEW.id);

    IF EXISTS (
        SELECT 1 FROM project_authorization_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM project_lifecycle_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM governance_audit_events WHERE project_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'project UUID has retained audit provenance'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION enforce_retained_audit_project_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_project_audit_provenance(NEW.project_id);

    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id
          AND organization_id <> NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'audit project belongs to another organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS project_authorization_audit_events_tenant_scope
    ON project_authorization_audit_events;
CREATE TRIGGER project_authorization_audit_events_00_provenance_lock
BEFORE INSERT OR UPDATE OF project_id, organization_id ON project_authorization_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_retained_audit_project_provenance();

DROP TRIGGER IF EXISTS project_lifecycle_audit_events_00_provenance_lock
    ON project_lifecycle_audit_events;
CREATE TRIGGER project_lifecycle_audit_events_00_provenance_lock
BEFORE INSERT OR UPDATE OF project_id, organization_id ON project_lifecycle_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_retained_audit_project_provenance();

DROP TRIGGER IF EXISTS governance_audit_events_00_provenance_lock
    ON governance_audit_events;
CREATE TRIGGER governance_audit_events_00_provenance_lock
BEFORE INSERT OR UPDATE OF project_id, organization_id ON governance_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_retained_audit_project_provenance();
