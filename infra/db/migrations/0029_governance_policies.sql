-- Approved policy versions are immutable. Their JSON fields deliberately contain
-- only retention intervals and a narrow redaction configuration, never source data.
CREATE TABLE IF NOT EXISTS governance_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id, project_id),
    UNIQUE (project_id)
);

CREATE TABLE IF NOT EXISTS governance_policy_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id UUID NOT NULL REFERENCES governance_policies(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    retention JSONB NOT NULL,
    redaction JSONB NOT NULL,
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_by TEXT NOT NULL CHECK (length(btrim(created_by)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(retention) = 'object'),
    CHECK (jsonb_typeof(redaction) = 'object'),
    CHECK ((redaction->>'mode') IN ('none', 'all_text')),
    CHECK (jsonb_typeof(COALESCE(redaction->'keys', '[]'::jsonb)) = 'array'),
    UNIQUE (policy_id, version),
    UNIQUE (policy_id, content_hash),
    FOREIGN KEY (policy_id, organization_id, project_id)
        REFERENCES governance_policies(id, organization_id, project_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS governance_policy_versions_project_history
    ON governance_policy_versions(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_policy_approvals (
    policy_version_id UUID PRIMARY KEY REFERENCES governance_policy_versions(id) ON DELETE RESTRICT,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actor_subject TEXT NOT NULL CHECK (length(btrim(actor_subject)) > 0),
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS governance_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    policy_version_id UUID NOT NULL REFERENCES governance_policy_versions(id) ON DELETE RESTRICT,
    actor_subject TEXT NOT NULL CHECK (length(btrim(actor_subject)) > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('policy_created', 'policy_approved', 'retention_previewed', 'retention_started', 'retention_completed', 'retention_failed')),
    counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_audit_events_project_history
    ON governance_audit_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS governance_retention_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    policy_version_id UUID NOT NULL REFERENCES governance_policy_versions(id) ON DELETE RESTRICT,
    requested_by TEXT NOT NULL CHECK (length(btrim(requested_by)) > 0),
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    cursor JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(cursor) = 'object'),
    counts JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK ((status = 'running' AND completed_at IS NULL) OR (status <> 'running' AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS governance_retention_runs_recovery
    ON governance_retention_runs(project_id, status, started_at);

CREATE OR REPLACE FUNCTION prevent_governance_immutable_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'governance records are immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS governance_policy_versions_immutable ON governance_policy_versions;
CREATE TRIGGER governance_policy_versions_immutable
    BEFORE UPDATE OR DELETE ON governance_policy_versions
    FOR EACH ROW EXECUTE FUNCTION prevent_governance_immutable_mutation();
DROP TRIGGER IF EXISTS governance_audit_events_immutable ON governance_audit_events;
CREATE TRIGGER governance_audit_events_immutable
    BEFORE UPDATE OR DELETE ON governance_audit_events
    FOR EACH ROW EXECUTE FUNCTION prevent_governance_immutable_mutation();
DROP TRIGGER IF EXISTS governance_policy_approvals_immutable ON governance_policy_approvals;
CREATE TRIGGER governance_policy_approvals_immutable
    BEFORE UPDATE OR DELETE ON governance_policy_approvals
    FOR EACH ROW EXECUTE FUNCTION prevent_governance_immutable_mutation();
