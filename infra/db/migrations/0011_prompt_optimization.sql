-- Glasshouse Postgres migrations: 0011_prompt_optimization

CREATE TABLE IF NOT EXISTS prompt_optimization_jobs (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE RESTRICT,
    prompt_slug TEXT NOT NULL,
    source_version INTEGER NOT NULL,
    target_role TEXT NOT NULL CHECK (target_role IN ('system', 'user')),
    source_messages JSONB NOT NULL,
    evaluator JSONB NOT NULL,
    examples JSONB NOT NULL,
    model_config JSONB NOT NULL,
    budget JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'optimizing', 'evaluating', 'completed', 'stopped', 'failed')),
    requested_by TEXT NOT NULL,
    result_version INTEGER,
    error_message TEXT,
    cancel_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS prompt_optimization_jobs_project_created_idx
    ON prompt_optimization_jobs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prompt_optimization_events (
    id BIGSERIAL PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES prompt_optimization_jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued', 'preparing', 'optimizing', 'evaluating', 'completed', 'stopped', 'failed')),
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_prompt_optimization_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'prompt optimization events are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS prompt_optimization_events_immutable ON prompt_optimization_events;
CREATE TRIGGER prompt_optimization_events_immutable
BEFORE UPDATE OR DELETE ON prompt_optimization_events
FOR EACH ROW EXECUTE FUNCTION prevent_prompt_optimization_event_mutation();
