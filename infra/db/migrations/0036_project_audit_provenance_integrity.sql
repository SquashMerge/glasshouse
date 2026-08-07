-- Retained audit provenance must continue to bind policy versions to their
-- original tenant while allowing permanent project deletion to remove versions.
ALTER TABLE governance_audit_events
    DISABLE TRIGGER governance_audit_events_immutable;
ALTER TABLE governance_audit_events
    DROP CONSTRAINT IF EXISTS governance_audit_events_policy_version_fkey;
ALTER TABLE governance_audit_events
    ADD CONSTRAINT governance_audit_events_policy_version_fkey
    FOREIGN KEY (policy_version_id, organization_id, project_id)
    REFERENCES governance_policy_versions(id, organization_id, project_id)
    ON DELETE SET NULL (policy_version_id);
ALTER TABLE governance_audit_events
    ENABLE TRIGGER governance_audit_events_immutable;

CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS projects_audit_uuid_reuse_guard ON projects;
CREATE TRIGGER projects_audit_uuid_reuse_guard
BEFORE INSERT OR UPDATE OF id ON projects
FOR EACH ROW EXECUTE FUNCTION prevent_project_audit_uuid_reuse();
