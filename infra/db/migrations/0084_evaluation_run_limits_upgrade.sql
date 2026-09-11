-- Add immutable execution limits for databases that already applied 0083.
ALTER TABLE evaluation_run_inputs
    ADD COLUMN IF NOT EXISTS limits JSONB NOT NULL
        DEFAULT '{"max_cost_usd":10,"max_duration_seconds":3600}'::jsonb;

ALTER TABLE evaluation_run_inputs
    DROP CONSTRAINT IF EXISTS evaluation_run_inputs_limits_check;
ALTER TABLE evaluation_run_inputs
    ADD CONSTRAINT evaluation_run_inputs_limits_check
    CHECK (jsonb_typeof(limits) = 'object');
