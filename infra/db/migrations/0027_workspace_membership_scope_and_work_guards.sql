-- Membership scope is identity, not mutable authorization state. Keep role
-- transitions serialized through the old parent row while rejecting moves.
CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' THEN
        PERFORM 1 FROM organizations WHERE id = OLD.organization_id FOR UPDATE;
        IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
            RAISE EXCEPTION 'organization membership scope is immutable';
        END IF;
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
        IF TG_OP = 'UPDATE' AND (
            NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        ) THEN
            RAISE EXCEPTION 'project membership scope is immutable';
        END IF;
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

DROP TRIGGER IF EXISTS organization_memberships_final_owner_guard ON organization_memberships;
CREATE TRIGGER organization_memberships_final_owner_guard
    BEFORE DELETE OR UPDATE OF role, organization_id ON organization_memberships
    FOR EACH ROW EXECUTE FUNCTION prevent_final_workspace_role_removal();

DROP TRIGGER IF EXISTS project_memberships_final_manager_guard ON project_memberships;
CREATE TRIGGER project_memberships_final_manager_guard
    BEFORE DELETE OR UPDATE OF role, project_id, organization_id ON project_memberships
    FOR EACH ROW EXECUTE FUNCTION prevent_final_workspace_role_removal();
