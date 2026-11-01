-- Short-lived, bounded copies of the audit-safe projection. The source ledgers
-- remain immutable and are never modified by pagination.
CREATE TABLE IF NOT EXISTS audit_log_snapshots (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    filter_hash TEXT NOT NULL,
    signing_key BYTEA NOT NULL CHECK (octet_length(signing_key) = 32),
    entries JSONB NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 5000),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (pg_column_size(entries) <= 2097152)
);
CREATE INDEX IF NOT EXISTS audit_log_snapshots_expiry_idx ON audit_log_snapshots (expires_at);
CREATE INDEX IF NOT EXISTS audit_log_snapshots_principal_idx ON audit_log_snapshots (organization_id, actor_id);

CREATE OR REPLACE FUNCTION glasshouse_invalidate_audit_snapshots_for_role()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.role IS DISTINCT FROM NEW.role THEN
        DELETE FROM audit_log_snapshots WHERE organization_id = OLD.organization_id AND actor_id = OLD.actor_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS glasshouse_invalidate_audit_snapshots_for_role ON organization_actor_roles;
CREATE TRIGGER glasshouse_invalidate_audit_snapshots_for_role
AFTER UPDATE OF role OR DELETE ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION glasshouse_invalidate_audit_snapshots_for_role();

CREATE OR REPLACE FUNCTION glasshouse_invalidate_audit_snapshots_for_project()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.status IS DISTINCT FROM NEW.status THEN
        DELETE FROM audit_log_snapshots WHERE organization_id = OLD.organization_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS glasshouse_invalidate_audit_snapshots_for_project ON projects;
CREATE TRIGGER glasshouse_invalidate_audit_snapshots_for_project
AFTER UPDATE OF status OR DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION glasshouse_invalidate_audit_snapshots_for_project();

CREATE OR REPLACE FUNCTION glasshouse_invalidate_audit_snapshots_for_credential()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.enabled IS DISTINCT FROM NEW.enabled OR OLD.auth_version IS DISTINCT FROM NEW.auth_version THEN
        DELETE FROM audit_log_snapshots WHERE organization_id = OLD.organization_id AND actor_id = OLD.actor_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS glasshouse_invalidate_audit_snapshots_for_credential ON local_credentials;
CREATE TRIGGER glasshouse_invalidate_audit_snapshots_for_credential
AFTER UPDATE OF enabled, auth_version OR DELETE ON local_credentials
FOR EACH ROW EXECUTE FUNCTION glasshouse_invalidate_audit_snapshots_for_credential();
