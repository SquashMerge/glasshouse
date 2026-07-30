-- Final GEPA metric-call telemetry is nullable because older jobs and some worker runtimes cannot report it.
ALTER TABLE prompt_optimization_jobs
    ADD COLUMN IF NOT EXISTS metric_calls_used INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_metric_calls_used_check'
    ) THEN
        ALTER TABLE prompt_optimization_jobs
            ADD CONSTRAINT prompt_optimization_jobs_metric_calls_used_check
            CHECK (metric_calls_used IS NULL OR metric_calls_used >= 0);
    END IF;
END
$$;
