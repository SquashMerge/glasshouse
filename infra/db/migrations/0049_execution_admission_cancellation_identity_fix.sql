CREATE OR REPLACE FUNCTION cancel_project_execution_admissions(
    target_organization_id UUID,
    target_project_id UUID,
    target_actor_subject TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    target_actor_id UUID;
BEGIN
    IF target_actor_subject IS NOT NULL THEN
        SELECT identity.actor_id INTO target_actor_id
        FROM actor_identities AS identity
        WHERE identity.organization_id = target_organization_id
          AND identity.provider_namespace = 'basic:v1'
          AND identity.canonical_subject = basic_auth_canonical_subject(target_actor_subject);
    END IF;

    UPDATE execution_admissions
    SET status = 'cancelled', cancelled_at = now()
    WHERE status = 'active'
      AND project_id = target_project_id
      AND (
          target_actor_subject IS NULL
          OR (target_actor_id IS NOT NULL AND requester_actor_id = target_actor_id)
      );

    UPDATE experiment_tasks AS task
    SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    FROM experiments AS experiment
    WHERE task.experiment_id = experiment.id
      AND task.status IN ('pending', 'running')
      AND experiment.project_id = target_project_id
      AND (
          target_actor_subject IS NULL
          OR (target_actor_id IS NOT NULL AND experiment.requested_by_actor_id = target_actor_id)
      );

    UPDATE experiments
    SET status = 'cancelled', updated_at = now()
    WHERE status IN ('pending', 'running')
      AND project_id = target_project_id
      AND (
          target_actor_subject IS NULL
          OR (target_actor_id IS NOT NULL AND requested_by_actor_id = target_actor_id)
      );

    WITH cancelled AS (
        UPDATE prompt_optimization_jobs AS job
        SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            status = 'stopped',
            updated_at = now(),
            completed_at = now()
        WHERE job.status IN ('queued', 'preparing', 'optimizing', 'evaluating')
          AND job.project_id = target_project_id
          AND (
              target_actor_subject IS NULL
              OR (
                  target_actor_id IS NOT NULL
                  AND basic_auth_identity_matches(
                      target_organization_id,
                      job.requested_by,
                      target_actor_id
                  )
              )
          )
        RETURNING job.id
    )
    INSERT INTO prompt_optimization_events (job_id, status, detail)
    SELECT id, 'stopped', '{"reason":"authorization_revoked"}'::jsonb
    FROM cancelled;
END;
$$;
