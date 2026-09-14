-- Name the durable cap for the Definition's requested sample size, not its
-- eventual selected item count. The controlled backfill preserves each
-- immutable Run snapshot before the stricter storage constraint is restored.
ALTER TABLE evaluation_run_inputs
    DROP CONSTRAINT IF EXISTS evaluation_run_inputs_execution_bounds_check;

ALTER TABLE evaluation_run_inputs
    DISABLE TRIGGER evaluation_run_inputs_immutable;

UPDATE evaluation_run_inputs
SET execution_bounds = jsonb_set(
    execution_bounds - 'max_cases',
    '{max_requested_sample_size}',
    COALESCE(
        execution_bounds->'max_requested_sample_size',
        execution_bounds->'max_cases'
    ),
    true
)
WHERE execution_bounds ? 'max_cases';

ALTER TABLE evaluation_run_inputs
    ENABLE TRIGGER evaluation_run_inputs_immutable;

ALTER TABLE evaluation_run_inputs
    ALTER COLUMN execution_bounds SET DEFAULT
        '{"max_active_runs_per_project":4,"max_active_runs_per_actor":2,"max_requested_sample_size":100,"max_provider_calls":100}'::jsonb;

ALTER TABLE evaluation_run_inputs
    ADD CONSTRAINT evaluation_run_inputs_execution_bounds_check CHECK (
        jsonb_typeof(execution_bounds) = 'object'
        AND jsonb_typeof(execution_bounds->'max_active_runs_per_project') = 'number'
        AND jsonb_typeof(execution_bounds->'max_active_runs_per_actor') = 'number'
        AND jsonb_typeof(execution_bounds->'max_requested_sample_size') = 'number'
        AND jsonb_typeof(execution_bounds->'max_provider_calls') = 'number'
        AND (execution_bounds->>'max_active_runs_per_project')::integer BETWEEN 1 AND 32
        AND (execution_bounds->>'max_active_runs_per_actor')::integer BETWEEN 1 AND 32
        AND (execution_bounds->>'max_requested_sample_size')::integer BETWEEN 1 AND 10000
        AND (execution_bounds->>'max_provider_calls')::integer BETWEEN 1 AND 10000
    );
