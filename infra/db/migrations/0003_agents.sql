-- Astraea Postgres migrations: 0003_agents
-- Agents are the typed first-class entity; manifest populated by SDK later.

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    framework TEXT,
    framework_version TEXT,
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_version TEXT,
    env TEXT NOT NULL DEFAULT 'development',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agents_env_check CHECK (env IN ('development', 'staging', 'production'))
);

CREATE INDEX IF NOT EXISTS idx_agents_project_id ON agents(project_id);
CREATE INDEX IF NOT EXISTS idx_agents_env ON agents(env);