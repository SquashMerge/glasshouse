-- Role changes within the non-Admin set can revoke writes, executions, and
-- curation. Fence every actual role change, not only transitions involving Admin.
CREATE OR REPLACE FUNCTION fence_durable_actor_role_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role IS NOT DISTINCT FROM NEW.role THEN
        RETURN NEW;
    END IF;
    PERFORM 1
    FROM project_memberships membership
    JOIN actor_identities identity
      ON identity.organization_id = membership.organization_id
     AND identity.actor_id = OLD.actor_id
     AND identity.provider_namespace = 'basic:v1'
     AND membership.actor_subject = identity.canonical_subject
    WHERE membership.organization_id = OLD.organization_id
    ORDER BY membership.project_id
    FOR UPDATE OF membership;
    PERFORM 1
    FROM project_actor_grants
    WHERE organization_id = OLD.organization_id
      AND actor_id = OLD.actor_id
    ORDER BY project_id
    FOR UPDATE;
    PERFORM 1
    FROM projects
    WHERE organization_id = OLD.organization_id
    ORDER BY id
    FOR UPDATE;
    FOR target_project_id IN
        SELECT id FROM projects WHERE organization_id = OLD.organization_id ORDER BY id
    LOOP
        PERFORM lock_project_audit_provenance(target_project_id);
        UPDATE projects
        SET authorization_epoch = authorization_epoch + 1
        WHERE id = target_project_id;
        PERFORM cancel_project_execution_admissions_for_actor(
            OLD.organization_id,
            target_project_id,
            OLD.actor_id
        );
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$$;
