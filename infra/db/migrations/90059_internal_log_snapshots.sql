-- Shared, short-lived pagination snapshots contain only identifiers and sort keys.
CREATE TABLE IF NOT EXISTS internal_log_snapshots (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    filter_hash TEXT NOT NULL,
    signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32),
    entry_ids UUID[] NOT NULL,
    recorded_ats TIMESTAMPTZ[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (cardinality(entry_ids) = cardinality(recorded_ats)),
    CHECK (cardinality(entry_ids) <= 50000),
    CHECK (pg_column_size(entry_ids) + pg_column_size(recorded_ats) <= 1250000)
);
CREATE INDEX IF NOT EXISTS internal_log_snapshots_expiry_idx ON internal_log_snapshots (expires_at);
CREATE INDEX IF NOT EXISTS internal_log_snapshots_actor_idx ON internal_log_snapshots (organization_id, actor_id);
