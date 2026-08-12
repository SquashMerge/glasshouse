-- Provider work is admitted in a short authorization transaction. The committed
-- epoch lets revocation cancel a dispatched invocation without holding locks over
-- an unbounded remote call.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS authorization_epoch BIGINT NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS execution_admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    requester_actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    work_kind TEXT NOT NULL CONSTRAINT execution_admissions_work_kind_check
        CHECK (work_kind IN ('optimization', 'experiment_task')),
    work_id UUID NOT NULL,
    authorization_epoch BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CONSTRAINT execution_admissions_status_check
        CHECK (status IN ('active', 'cancelled', 'completed')),
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    cancelled_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT execution_admissions_project_scope_fkey
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    CONSTRAINT execution_admissions_terminal_timestamp_check CHECK (
        (status = 'active' AND cancelled_at IS NULL AND completed_at IS NULL)
        OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS execution_admissions_active_project_requester_idx
    ON execution_admissions (project_id, requester_actor_id, authorization_epoch)
    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS execution_admissions_work_idx
    ON execution_admissions (work_kind, work_id);

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
      AND (target_actor_id IS NULL OR requester_actor_id = target_actor_id);

    UPDATE experiment_tasks AS task
    SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    FROM experiments AS experiment
    WHERE task.experiment_id = experiment.id
      AND task.status IN ('pending', 'running')
      AND experiment.project_id = target_project_id
      AND (target_actor_id IS NULL OR experiment.requested_by_actor_id = target_actor_id);

    UPDATE experiments
    SET status = 'cancelled', updated_at = now()
    WHERE status IN ('pending', 'running')
      AND project_id = target_project_id
      AND (target_actor_id IS NULL OR requested_by_actor_id = target_actor_id);

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
              OR basic_auth_identity_matches(
                  target_organization_id,
                  job.requested_by,
                  target_actor_subject
              )
          )
        RETURNING job.id
    )
    INSERT INTO prompt_optimization_events (job_id, status, detail)
    SELECT id, 'stopped', '{"reason":"authorization_revoked"}'::jsonb
    FROM cancelled;
END;
$$;

CREATE OR REPLACE FUNCTION fence_authorization_membership_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
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
        FOR target_project_id IN
            SELECT id
            FROM projects
            WHERE organization_id = OLD.organization_id
            ORDER BY id
            FOR UPDATE
        LOOP
            UPDATE projects
            SET authorization_epoch = authorization_epoch + 1
            WHERE id = target_project_id;
            PERFORM cancel_project_execution_admissions(
                OLD.organization_id,
                target_project_id,
                OLD.actor_subject
            );
        END LOOP;
    ELSIF TG_TABLE_NAME = 'project_memberships' THEN
        SELECT id INTO target_project_id
        FROM projects
        WHERE id = OLD.project_id
          AND organization_id = OLD.organization_id
        FOR UPDATE;
        IF target_project_id IS NOT NULL THEN
            UPDATE projects
            SET authorization_epoch = authorization_epoch + 1
            WHERE id = target_project_id;
            PERFORM cancel_project_execution_admissions(
                OLD.organization_id,
                target_project_id,
                OLD.actor_subject
            );
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION cancel_archived_project_execution_admissions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status <> 'active' THEN
        PERFORM cancel_project_execution_admissions(
            OLD.organization_id,
            OLD.id,
            NULL
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_execution_admission_archive_fence ON projects;
CREATE TRIGGER project_execution_admission_archive_fence
BEFORE UPDATE OF status ON projects
FOR EACH ROW EXECUTE FUNCTION cancel_archived_project_execution_admissions();
