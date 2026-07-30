-- Durable actor membership and project lifecycle boundary for workspace authorization.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_by TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS projects_id_organization_id_key ON projects(id, organization_id);

CREATE TABLE IF NOT EXISTS organization_memberships (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_subject TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, actor_subject)
);

CREATE TABLE IF NOT EXISTS project_memberships (
    project_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    actor_subject TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('manager', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, actor_subject),
    FOREIGN KEY (project_id, organization_id) REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (organization_id, actor_subject) REFERENCES organization_memberships(organization_id, actor_subject) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS project_memberships_actor_project_idx ON project_memberships(actor_subject, project_id);

CREATE TABLE IF NOT EXISTS project_authorization_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
    actor_subject TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'bootstrap_owner_added', 'bootstrap_manager_added', 'organization_membership_created',
        'organization_membership_updated', 'organization_membership_removed',
        'project_created', 'project_updated', 'project_archived', 'project_restored',
        'project_membership_created', 'project_membership_updated', 'project_membership_removed'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' AND OLD.role = 'owner' AND
       NOT EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = OLD.organization_id AND actor_subject <> OLD.actor_subject AND role = 'owner') THEN
        RAISE EXCEPTION 'cannot remove or demote the final organization owner';
    END IF;
    IF TG_TABLE_NAME = 'project_memberships' AND OLD.role = 'manager' AND
       EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'active') AND
       NOT EXISTS (SELECT 1 FROM project_memberships WHERE project_id = OLD.project_id AND actor_subject <> OLD.actor_subject AND role = 'manager') THEN
        RAISE EXCEPTION 'cannot remove or demote the final active project manager';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS organization_memberships_final_owner_guard ON organization_memberships;
CREATE TRIGGER organization_memberships_final_owner_guard BEFORE DELETE OR UPDATE OF role ON organization_memberships
    FOR EACH ROW EXECUTE FUNCTION prevent_final_workspace_role_removal();
DROP TRIGGER IF EXISTS project_memberships_final_manager_guard ON project_memberships;
CREATE TRIGGER project_memberships_final_manager_guard BEFORE DELETE OR UPDATE OF role ON project_memberships
    FOR EACH ROW EXECUTE FUNCTION prevent_final_workspace_role_removal();
