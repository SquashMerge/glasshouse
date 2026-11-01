-- Invalidate previously authorized cursors whenever an Admin loses the role.
-- The role row is already locked by the mutation, matching the log read fence.
CREATE OR REPLACE FUNCTION glasshouse_invalidate_internal_log_snapshots()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role IS DISTINCT FROM 'admin') THEN
        DELETE FROM internal_log_snapshots
        WHERE organization_id = OLD.organization_id AND actor_id = OLD.actor_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS glasshouse_invalidate_internal_log_snapshots ON organization_actor_roles;
CREATE TRIGGER glasshouse_invalidate_internal_log_snapshots
AFTER UPDATE OF role OR DELETE ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION glasshouse_invalidate_internal_log_snapshots();
