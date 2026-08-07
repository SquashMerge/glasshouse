-- Permanent deletion crosses PostgreSQL and ClickHouse, so its recovery record
-- deliberately outlives the project row and contains no project content.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects
    ADD CONSTRAINT projects_status_check
    CHECK (status IN ('active', 'archived', 'deleting'));

CREATE TABLE IF NOT EXISTS project_deletion_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    requested_by TEXT NOT NULL CHECK (length(btrim(requested_by)) > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'traces_cleaned', 'clickhouse_cleaned', 'failed', 'completed')),
    traces_cleaned_at TIMESTAMPTZ,
    observations_cleaned_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, project_id),
    CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS project_deletion_jobs_recovery_idx
    ON project_deletion_jobs(organization_id, status, updated_at);

ALTER TABLE project_lifecycle_audit_events
    DROP CONSTRAINT IF EXISTS project_lifecycle_audit_events_event_type_check;
ALTER TABLE project_lifecycle_audit_events
    ADD CONSTRAINT project_lifecycle_audit_events_event_type_check
    CHECK (event_type IN ('project_created', 'default_changed', 'deletion_attempted', 'deletion_completed', 'deletion_failed'));
