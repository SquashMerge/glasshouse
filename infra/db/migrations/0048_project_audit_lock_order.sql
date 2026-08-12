-- PostgreSQL acquires the target membership row lock before a BEFORE ROW
-- trigger runs. The durable authorization order is therefore membership rows,
-- Project rows, then per-Project audit advisory locks. Organization/default
-- rows and all dependent work are locked only after that fence.
CREATE OR REPLACE FUNCTION fence_authorization_membership_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
    target_project_ids UUID[];
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;

    -- Promotions do not revoke an existing authorization epoch.
    IF TG_OP = 'UPDATE' AND (
        (TG_TABLE_NAME = 'organization_memberships' AND NOT (OLD.role = 'owner' AND NEW.role = 'member'))
        OR (TG_TABLE_NAME = 'project_memberships' AND NOT (OLD.role = 'manager' AND NEW.role = 'member'))
    ) THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'organization_memberships' THEN
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO target_project_ids
        FROM (
            SELECT id
            FROM projects
            WHERE organization_id = OLD.organization_id
            ORDER BY id
            FOR UPDATE
        ) AS locked_projects;
    ELSE
        SELECT COALESCE(array_agg(id ORDER BY id), ARRAY[]::uuid[]) INTO target_project_ids
        FROM (
            SELECT id
            FROM projects
            WHERE id = OLD.project_id
              AND organization_id = OLD.organization_id
            FOR UPDATE
        ) AS locked_projects;
    END IF;

    FOREACH target_project_id IN ARRAY target_project_ids LOOP
        PERFORM lock_project_audit_provenance(target_project_id);
    END LOOP;

    FOREACH target_project_id IN ARRAY target_project_ids LOOP
        UPDATE projects
        SET authorization_epoch = authorization_epoch + 1
        WHERE id = target_project_id;
        PERFORM cancel_project_execution_admissions(
            OLD.organization_id,
            target_project_id,
            OLD.actor_subject
        );
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION enforce_retained_audit_project_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- A live Project is fenced before its audit UUID. Deleted Projects have no
    -- row to lock, so their retained UUID is serialized by the advisory lock.
    PERFORM 1
    FROM projects
    WHERE id = NEW.project_id
    FOR KEY SHARE;

    PERFORM lock_project_audit_provenance(NEW.project_id);

    -- Recheck after taking the advisory lock so a concurrent UUID reuse cannot
    -- appear between the live-row fence and the retained-provenance fence.
    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE id = NEW.project_id
          AND organization_id <> NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'audit project belongs to another organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fence_authorization_membership_revocation() IS
    'PostgreSQL locks the target membership before this trigger; revocation then locks Projects and their audit advisory locks in UUID order.';
COMMENT ON FUNCTION enforce_retained_audit_project_provenance() IS
    'Locks a live Project before its retained-audit UUID advisory lock; a deleted Project is protected by its advisory UUID alone.';
