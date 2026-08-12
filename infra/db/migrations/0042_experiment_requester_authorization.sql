-- Evaluation workers act only for the durable Basic Auth actor that initiated
-- the experiment. Historical work has no trustworthy requester and is cancelled.
ALTER TABLE experiments
    ADD COLUMN IF NOT EXISTS requested_by_actor_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'experiments_requested_by_actor_id_fkey'
          AND conrelid = 'experiments'::regclass
    ) THEN
        ALTER TABLE experiments
            ADD CONSTRAINT experiments_requested_by_actor_id_fkey
            FOREIGN KEY (requested_by_actor_id) REFERENCES actors(id) ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_experiments_requested_by_actor_id
    ON experiments (requested_by_actor_id)
    WHERE requested_by_actor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_experiment_requester_actor_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.requested_by_actor_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM projects AS project
           JOIN actor_identities AS identity
             ON identity.organization_id = project.organization_id
            AND identity.actor_id = NEW.requested_by_actor_id
            AND identity.provider_namespace = 'basic:v1'
           WHERE project.id = NEW.project_id
       ) THEN
        RAISE EXCEPTION 'experiment requester actor is not scoped to the project organization';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS experiments_requester_actor_scope ON experiments;
CREATE TRIGGER experiments_requester_actor_scope
BEFORE INSERT OR UPDATE OF project_id, requested_by_actor_id ON experiments
FOR EACH ROW EXECUTE FUNCTION enforce_experiment_requester_actor_scope();

UPDATE experiment_tasks
SET status = 'cancelled',
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE experiment_id IN (
    SELECT id
    FROM experiments
    WHERE requested_by_actor_id IS NULL
      AND status IN ('pending', 'running')
)
  AND status IN ('pending', 'running');

UPDATE experiments
SET status = 'cancelled',
    updated_at = now()
WHERE requested_by_actor_id IS NULL
  AND status IN ('pending', 'running');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'experiments_active_requester_actor_check'
          AND conrelid = 'experiments'::regclass
    ) THEN
        ALTER TABLE experiments
            ADD CONSTRAINT experiments_active_requester_actor_check
            CHECK (
                requested_by_actor_id IS NOT NULL
                OR status NOT IN ('pending', 'running')
            );
    END IF;
END
$$;
