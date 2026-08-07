-- The default is organization-owned and must always name a project in that organization.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_project_id UUID;

UPDATE organizations AS organization
SET default_project_id = selected.id
FROM LATERAL (
    SELECT project.id
    FROM projects AS project
    WHERE project.organization_id = organization.id AND project.status = 'active'
    ORDER BY (project.slug = 'default') DESC, project.created_at, project.id
    LIMIT 1
) AS selected
WHERE organization.default_project_id IS NULL;

ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_default_project_organization_fkey;
ALTER TABLE organizations
    ADD CONSTRAINT organizations_default_project_organization_fkey
    FOREIGN KEY (default_project_id, id)
    REFERENCES projects(id, organization_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_default_project_deactivation() RETURNS trigger AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM organizations
        WHERE id = OLD.organization_id AND default_project_id = OLD.id
    ) AND (TG_OP = 'DELETE' OR NEW.status <> 'active') THEN
        RAISE EXCEPTION 'default project must remain active';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_default_project_guard ON projects;
CREATE TRIGGER projects_default_project_guard
BEFORE DELETE OR UPDATE OF status ON projects
FOR EACH ROW EXECUTE FUNCTION prevent_default_project_deactivation();

ALTER TABLE project_memberships DROP CONSTRAINT IF EXISTS project_memberships_project_id_organization_id_fkey;
ALTER TABLE project_memberships
    ADD CONSTRAINT project_memberships_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE;

ALTER TABLE prompt_optimization_jobs DROP CONSTRAINT IF EXISTS prompt_optimization_jobs_project_id_fkey;
ALTER TABLE prompt_optimization_jobs
    ADD CONSTRAINT prompt_optimization_jobs_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE project_authorization_audit_events
    DISABLE TRIGGER project_authorization_audit_events_immutable;
ALTER TABLE project_authorization_audit_events
    ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE project_authorization_audit_events
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_project_organization_fkey;
ALTER TABLE project_authorization_audit_events
    ADD CONSTRAINT project_authorization_audit_events_project_organization_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE SET NULL;
ALTER TABLE project_authorization_audit_events
    ENABLE TRIGGER project_authorization_audit_events_immutable;

CREATE TABLE IF NOT EXISTS project_lifecycle_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    actor_subject TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('project_created', 'default_changed', 'deletion_attempted', 'deletion_completed', 'deletion_failed')),
    result JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_lifecycle_audit_events_project_idx
    ON project_lifecycle_audit_events(organization_id, project_id, created_at);
