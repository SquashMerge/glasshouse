-- Persist the operator-resolved execution envelope with each admitted Run.
-- Capacity and provider-call charges are ledgered in PostgreSQL so independent
-- API processes cannot over-admit or dispatch around the bounds.
ALTER TABLE evaluation_run_inputs
    ADD COLUMN IF NOT EXISTS execution_bounds JSONB NOT NULL DEFAULT
        '{"max_active_runs_per_project":4,"max_active_runs_per_actor":2,"max_cases":100,"max_provider_calls":100}'::jsonb;

ALTER TABLE evaluation_run_inputs
    DROP CONSTRAINT IF EXISTS evaluation_run_inputs_execution_bounds_check;
ALTER TABLE evaluation_run_inputs
    ADD CONSTRAINT evaluation_run_inputs_execution_bounds_check CHECK (
        jsonb_typeof(execution_bounds) = 'object'
        AND jsonb_typeof(execution_bounds->'max_active_runs_per_project') = 'number'
        AND jsonb_typeof(execution_bounds->'max_active_runs_per_actor') = 'number'
        AND jsonb_typeof(execution_bounds->'max_cases') = 'number'
        AND jsonb_typeof(execution_bounds->'max_provider_calls') = 'number'
        AND (execution_bounds->>'max_active_runs_per_project')::integer BETWEEN 1 AND 32
        AND (execution_bounds->>'max_active_runs_per_actor')::integer BETWEEN 1 AND 32
        AND (execution_bounds->>'max_cases')::integer BETWEEN 1 AND 10000
        AND (execution_bounds->>'max_provider_calls')::integer BETWEEN 1 AND 10000
    );

ALTER TABLE evaluation_runs
    ADD COLUMN IF NOT EXISTS provider_call_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evaluation_runs
    DROP CONSTRAINT IF EXISTS evaluation_runs_provider_call_count_check;
ALTER TABLE evaluation_runs
    ADD CONSTRAINT evaluation_runs_provider_call_count_check
    CHECK (provider_call_count >= 0);

CREATE TABLE IF NOT EXISTS evaluation_run_capacity_admissions (
    run_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('active', 'released')),
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, project_id)
        REFERENCES evaluation_runs(id, project_id) ON DELETE CASCADE,
    CHECK (
        (status = 'active' AND released_at IS NULL AND release_reason IS NULL)
        OR (status = 'released' AND released_at IS NOT NULL AND release_reason IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS evaluation_run_capacity_active_project_actor_idx
    ON evaluation_run_capacity_admissions(project_id, actor_id)
    WHERE status = 'active';

INSERT INTO evaluation_run_capacity_admissions (
    run_id, organization_id, project_id, actor_id, status
)
SELECT id, organization_id, project_id, requested_by_actor_id, 'active'
FROM evaluation_runs
WHERE status IN ('pending', 'running')
ON CONFLICT (run_id) DO NOTHING;

CREATE OR REPLACE FUNCTION release_evaluation_run_capacity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('pending', 'running')
       AND NEW.status IN ('completed', 'failed', 'cancelled') THEN
        UPDATE evaluation_run_capacity_admissions
        SET status = 'released',
            released_at = now(),
            release_reason = COALESCE(NEW.terminal_reason, NEW.status)
        WHERE run_id = NEW.id
          AND project_id = NEW.project_id
          AND status = 'active';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS evaluation_run_capacity_release ON evaluation_runs;
CREATE TRIGGER evaluation_run_capacity_release
AFTER UPDATE OF status ON evaluation_runs
FOR EACH ROW EXECUTE FUNCTION release_evaluation_run_capacity();
