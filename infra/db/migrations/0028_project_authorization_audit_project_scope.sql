-- Organization-level authorization events are routed through a deterministic
-- project in the same organization so audit rows retain complete tenancy.
INSERT INTO projects (name, slug, organization_id)
SELECT 'Default Project', 'default', organization.id
FROM organizations AS organization
WHERE NOT EXISTS (
    SELECT 1
    FROM projects
    WHERE projects.organization_id = organization.id
)
ON CONFLICT (organization_id, slug) DO NOTHING;

ALTER TABLE project_authorization_audit_events
    DISABLE TRIGGER project_authorization_audit_events_immutable;

UPDATE project_authorization_audit_events AS event
SET project_id = (
    SELECT project.id
    FROM projects AS project
    WHERE project.organization_id = event.organization_id
    ORDER BY (project.slug = 'default') DESC, project.created_at, project.id
    LIMIT 1
)
WHERE event.project_id IS NULL;

ALTER TABLE project_authorization_audit_events
    ENABLE TRIGGER project_authorization_audit_events_immutable;

ALTER TABLE project_authorization_audit_events
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_project_id_fkey;
ALTER TABLE project_authorization_audit_events
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_project_organization_fkey;
ALTER TABLE project_authorization_audit_events
    ADD CONSTRAINT project_authorization_audit_events_project_organization_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id)
    ON DELETE RESTRICT;
ALTER TABLE project_authorization_audit_events
    ALTER COLUMN project_id SET NOT NULL;
