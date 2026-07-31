-- Serialize role transitions through their tenant/project parent rows and
-- preserve audit events as immutable tenant-scoped facts.
CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' THEN
        PERFORM 1 FROM organizations WHERE id = OLD.organization_id FOR UPDATE;
        IF OLD.role = 'owner'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND NOT EXISTS (
                SELECT 1 FROM organization_memberships
                WHERE organization_id = OLD.organization_id
                    AND actor_subject <> OLD.actor_subject
                    AND role = 'owner'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final organization owner';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'project_memberships' THEN
        PERFORM 1 FROM projects WHERE id = OLD.project_id FOR UPDATE;
        IF OLD.role = 'manager'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'active')
            AND NOT EXISTS (
                SELECT 1 FROM project_memberships
                WHERE project_id = OLD.project_id
                    AND actor_subject <> OLD.actor_subject
                    AND role = 'manager'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final active project manager';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_managerless_project_restore() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'archived' AND NEW.status = 'active'
        AND NOT EXISTS (
            SELECT 1 FROM project_memberships
            WHERE project_id = NEW.id AND role = 'manager'
        ) THEN
        RAISE EXCEPTION 'cannot restore a project without a manager';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS projects_managerless_restore_guard ON projects;
CREATE TRIGGER projects_managerless_restore_guard
    BEFORE UPDATE OF status ON projects
    FOR EACH ROW EXECUTE FUNCTION prevent_managerless_project_restore();

ALTER TABLE project_authorization_audit_events
    DROP CONSTRAINT IF EXISTS project_authorization_audit_events_project_id_fkey;
ALTER TABLE project_authorization_audit_events
    ADD CONSTRAINT project_authorization_audit_events_project_organization_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id)
    ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_project_authorization_audit_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'project authorization audit events are append-only'
        USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS project_authorization_audit_events_immutable ON project_authorization_audit_events;
CREATE TRIGGER project_authorization_audit_events_immutable
    BEFORE UPDATE OR DELETE ON project_authorization_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_project_authorization_audit_mutation();
