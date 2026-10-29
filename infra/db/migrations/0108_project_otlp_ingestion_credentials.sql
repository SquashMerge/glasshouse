-- Project-bound ingestion-only credentials. The bearer secret is never stored.

CREATE TABLE IF NOT EXISTS project_otlp_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL,
    name TEXT NOT NULL,
    secret_digest TEXT NOT NULL UNIQUE CHECK (secret_digest ~ '^[0-9a-f]{64}$'),
    secret_prefix TEXT NOT NULL,
    created_by_actor_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT project_otlp_credentials_name_check CHECK (btrim(name) <> '' AND char_length(name) <= 100),
    CONSTRAINT project_otlp_credentials_project_scope_fk
        FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE CASCADE,
    CONSTRAINT project_otlp_credentials_creator_scope_fk
        FOREIGN KEY (organization_id, created_by_actor_id)
        REFERENCES actor_identities(organization_id, actor_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS project_otlp_credentials_project_created_idx
    ON project_otlp_credentials (organization_id, project_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS project_otlp_credentials_active_digest_idx
    ON project_otlp_credentials (secret_digest)
    WHERE revoked_at IS NULL;

-- Extend the existing immutable, content-free Admin audit stream with credential
-- lifecycle actions. The Project identifies the affected resource boundary;
-- the event never carries the credential secret or telemetry content.
ALTER TABLE admin_access_audit_events
    DROP CONSTRAINT IF EXISTS admin_access_audit_events_action_check;
ALTER TABLE admin_access_audit_events
    ADD CONSTRAINT admin_access_audit_events_action_check CHECK (action IN (
        'actor_identity_linked',
        'bootstrap_owner_granted',
        'organization_role_set',
        'project_grant_set',
        'project_grant_revoked',
        'recovery_succeeded',
        'recovery_denied',
        'recovery_rate_limited',
        'project_otlp_credential_created',
        'project_otlp_credential_rotated',
        'project_otlp_credential_revoked'
    ));
