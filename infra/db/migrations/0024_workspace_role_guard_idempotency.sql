CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships'
        AND OLD.role = 'owner'
        AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
        AND NOT EXISTS (
            SELECT 1 FROM organization_memberships
            WHERE organization_id = OLD.organization_id
                AND actor_subject <> OLD.actor_subject
                AND role = 'owner'
        ) THEN
        RAISE EXCEPTION 'cannot remove or demote the final organization owner';
    END IF;
    IF TG_TABLE_NAME = 'project_memberships'
        AND OLD.role = 'manager'
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
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
