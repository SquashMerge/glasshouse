-- Archived Projects must remain manageable after restore. Durable policy is the
-- authority; legacy Basic Auth membership rows are compatibility projections.
CREATE OR REPLACE FUNCTION prevent_managerless_project_restore() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'archived' AND NEW.status = 'active'
        AND NOT EXISTS (
            SELECT 1
            FROM organization_actor_roles role
            JOIN actor_identities identity
              ON identity.organization_id = role.organization_id
             AND identity.actor_id = role.actor_id
            WHERE role.organization_id = NEW.organization_id
              AND authorization_allows_project(
                  NEW.organization_id,
                  NEW.id,
                  role.actor_id,
                  'project_manage'
              )
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
