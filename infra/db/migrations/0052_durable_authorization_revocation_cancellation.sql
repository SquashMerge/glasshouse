CREATE OR REPLACE FUNCTION cancel_project_execution_admissions_for_actor(
    target_organization_id UUID,
    target_project_id UUID,
    target_actor_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
BEGIN
    UPDATE execution_admissions
    SET status = 'cancelled', cancelled_at = now()
    WHERE status = 'active'
      AND project_id = target_project_id
      AND requester_actor_id = target_actor_id;

    UPDATE experiment_tasks AS task
    SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    FROM experiments AS experiment
    WHERE task.experiment_id = experiment.id
      AND task.status IN ('pending', 'running')
      AND experiment.project_id = target_project_id
      AND experiment.requested_by_actor_id = target_actor_id;

    UPDATE experiments
    SET status = 'cancelled', updated_at = now()
    WHERE status IN ('pending', 'running')
      AND project_id = target_project_id
      AND requested_by_actor_id = target_actor_id;

    WITH cancelled AS (
        UPDATE prompt_optimization_jobs AS job
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            status = 'stopped',
            updated_at = now(),
            completed_at = now()
        WHERE job.status IN ('queued', 'preparing', 'optimizing', 'evaluating')
          AND job.project_id = target_project_id
          AND basic_auth_identity_matches(
              target_organization_id,
              job.requested_by,
              target_actor_id
          )
        RETURNING job.id
    )
    INSERT INTO prompt_optimization_events (job_id, status, detail)
    SELECT id, 'stopped', '{"reason":"authorization_revoked"}'::jsonb
    FROM cancelled;
END;
$$;

CREATE OR REPLACE FUNCTION fence_durable_actor_role_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.role <> 'admin' AND NEW.role <> 'admin' THEN
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

CREATE OR REPLACE FUNCTION fence_durable_project_grant_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM projects WHERE id = OLD.project_id FOR UPDATE;
    PERFORM lock_project_audit_provenance(OLD.project_id);
    UPDATE projects
    SET authorization_epoch = authorization_epoch + 1
    WHERE id = OLD.project_id;
    PERFORM cancel_project_execution_admissions_for_actor(
        OLD.organization_id,
        OLD.project_id,
        OLD.actor_id
    );
    RETURN COALESCE(NEW, OLD);
END;
$$;
