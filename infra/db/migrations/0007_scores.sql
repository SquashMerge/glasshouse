-- Astraea Postgres migrations: 0007_scores
-- Top-level score stream. Scores can exist without a trace_id (e.g., heuristic
-- evaluations against datasets). experiment_id is SET NULL on experiment deletion
-- so scores survive experiment cleanup.

CREATE TABLE IF NOT EXISTS scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    trace_id TEXT,
    experiment_id UUID REFERENCES experiments(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    value NUMERIC NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scores_project_id ON scores(project_id);
CREATE INDEX IF NOT EXISTS idx_scores_trace_id ON scores(trace_id);
CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name);
CREATE INDEX IF NOT EXISTS idx_scores_created_at ON scores(created_at DESC);