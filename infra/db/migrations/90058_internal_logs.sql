-- Glasshouse Postgres migrations: 90058_internal_logs
-- Tenant-scoped, sanitized API operational records for the Settings Logs page.

CREATE TABLE IF NOT EXISTS internal_log_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
    source TEXT NOT NULL CHECK (source = 'api'),
    message TEXT NOT NULL CHECK (message = 'API request outcome'),
    context JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS internal_log_entries_organization_recorded_id_idx
    ON internal_log_entries (organization_id, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS internal_log_entries_organization_source_recorded_id_idx
    ON internal_log_entries (organization_id, source, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS internal_log_entries_recorded_at_idx
    ON internal_log_entries (recorded_at ASC, id ASC);
