-- Astraea Postgres migrations: 0011_customer_api_credentials
-- Opaque customer credentials are stored only as SHA-256 hashes.

CREATE TABLE IF NOT EXISTS customer_api_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    secret_prefix TEXT NOT NULL,
    secret_fingerprint TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT customer_api_credentials_display_name_check CHECK (btrim(display_name) <> ''),
    CONSTRAINT customer_api_credentials_scopes_check CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['prompts:read', 'prompts:render', 'prompts:write']::TEXT[]
    )
);

CREATE INDEX IF NOT EXISTS customer_api_credentials_project_created_idx
    ON customer_api_credentials (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_api_credentials_active_lookup_idx
    ON customer_api_credentials (secret_hash)
    WHERE revoked_at IS NULL;
