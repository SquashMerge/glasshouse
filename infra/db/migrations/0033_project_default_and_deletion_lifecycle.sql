-- The default is organization-owned and must always name a project in that organization.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_project_id UUID;

-- Do not revive archived data merely to satisfy the new default invariant.
-- Organizations with no active project receive a deterministic new default instead.
WITH RECURSIVE missing_active_project AS (
    SELECT organization.id
    FROM organizations AS organization
    WHERE NOT EXISTS (
        SELECT 1
        FROM projects AS project
        WHERE project.organization_id = organization.id
          AND project.status = 'active'
    )
), slug_candidates AS (
    SELECT id AS organization_id, 0 AS attempt, 'default'::text AS slug
    FROM missing_active_project
    UNION ALL
    SELECT
        candidate.organization_id,
        candidate.attempt + 1,
        'default-' || replace(candidate.organization_id::text, '-', '') ||
            CASE
                WHEN candidate.attempt = 0 THEN ''
                ELSE '-' || (candidate.attempt + 1)::text
            END
    FROM slug_candidates AS candidate
    WHERE EXISTS (
        SELECT 1
        FROM projects AS project
        WHERE project.organization_id = candidate.organization_id
          AND project.slug = candidate.slug
    )
), provisioned AS (
    INSERT INTO projects (name, slug, organization_id, status)
    SELECT
        'Default Project',
        candidate.slug,
        candidate.organization_id,
        'active'
    FROM slug_candidates AS candidate
    WHERE NOT EXISTS (
        SELECT 1
        FROM projects AS project
        WHERE project.organization_id = candidate.organization_id
          AND project.slug = candidate.slug
    )
    RETURNING id, organization_id
)
INSERT INTO project_memberships (project_id, organization_id, actor_subject, role)
SELECT provisioned.id, provisioned.organization_id, membership.actor_subject, 'manager'
FROM provisioned
JOIN organization_memberships AS membership
  ON membership.organization_id = provisioned.organization_id
 AND membership.role = 'owner'
ON CONFLICT (project_id, actor_subject) DO NOTHING;

UPDATE organizations AS organization
SET default_project_id = (
    SELECT project.id
    FROM projects AS project
    WHERE project.organization_id = organization.id
      AND project.status = 'active'
    ORDER BY (project.slug = 'default') DESC, project.created_at, project.id
    LIMIT 1
)
WHERE organization.default_project_id IS NULL
  AND EXISTS (
      SELECT 1
      FROM projects AS project
      WHERE project.organization_id = organization.id
        AND project.status = 'active'
  );

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
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_project_organization_fkey;

CREATE OR REPLACE FUNCTION enforce_project_authorization_audit_tenant_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id
          AND organization_id <> NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'authorization audit project belongs to another organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS project_authorization_audit_events_tenant_scope ON project_authorization_audit_events;
CREATE TRIGGER project_authorization_audit_events_tenant_scope
BEFORE INSERT ON project_authorization_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_project_authorization_audit_tenant_scope();

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
