-- Preview authorization is deliberately metadata-only. It proves that a manager
-- reviewed a bounded, policy-specific snapshot before starting destruction.
CREATE TABLE IF NOT EXISTS governance_retention_previews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    policy_version_id UUID NOT NULL,
    actor_subject TEXT NOT NULL CHECK (length(btrim(actor_subject)) > 0),
    counts JSONB NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    CHECK (expires_at > created_at),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (policy_version_id, organization_id, project_id)
        REFERENCES governance_policy_versions(id, organization_id, project_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS governance_retention_previews_lookup
    ON governance_retention_previews(id, organization_id, project_id, actor_subject)
    WHERE consumed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS governance_retention_runs_one_running_per_project
    ON governance_retention_runs(project_id)
    WHERE status = 'running';
