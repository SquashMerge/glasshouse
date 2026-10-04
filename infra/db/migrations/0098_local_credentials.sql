-- Local subjects include the organization UUID because the identity registry's
-- provider/subject primary key is global. Basic identities remain untouched.
ALTER TABLE actor_identities ADD CONSTRAINT actor_identities_local_scope_key
    UNIQUE (organization_id, actor_id, provider_namespace, canonical_subject);

CREATE TABLE local_credentials (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    username TEXT COLLATE "C" NOT NULL CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    provider_namespace TEXT NOT NULL DEFAULT 'local:v1' CHECK (provider_namespace = 'local:v1'),
    canonical_subject TEXT GENERATED ALWAYS AS (organization_id::text || ':' || username) STORED,
    password_hash TEXT,
    password_algorithm TEXT,
    password_version INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, username),
    UNIQUE (organization_id, actor_id),
    UNIQUE (actor_id),
    FOREIGN KEY (organization_id, actor_id, provider_namespace, canonical_subject)
        REFERENCES actor_identities (organization_id, actor_id, provider_namespace, canonical_subject) ON DELETE RESTRICT,
    CHECK ((password_hash IS NULL AND password_algorithm IS NULL AND password_version IS NULL)
        OR (password_hash IS NOT NULL AND password_algorithm IS NOT NULL AND password_version IS NOT NULL
            AND password_algorithm = 'argon2id' AND password_version > 0
            AND password_hash ~ '^\$argon2id\$v=19\$m=[0-9]+,t=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'))
);

CREATE TABLE local_bootstrap_controls (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
    token_digest BYTEA CHECK (octet_length(token_digest) = 32),
    provisioned_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    CHECK ((token_digest IS NULL AND provisioned_at IS NULL AND expires_at IS NULL)
        OR (token_digest IS NOT NULL AND provisioned_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at = provisioned_at + interval '24 hours')),
    CHECK (closed_at IS NULL OR token_digest IS NULL)
);

INSERT INTO local_bootstrap_controls (organization_id, closed_at)
SELECT organization.id, CASE WHEN EXISTS (
    SELECT 1 FROM organization_actor_roles role
    WHERE role.organization_id = organization.id AND role.role = 'admin'
) THEN now() END FROM organizations organization;

CREATE FUNCTION initialize_local_bootstrap_control() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO local_bootstrap_controls (organization_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_local_bootstrap_control AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION initialize_local_bootstrap_control();

-- Every Admin creation, including the Basic compatibility/recovery path, closes
-- setup under the same row fence used by token provisioning and consumption.
CREATE FUNCTION close_local_bootstrap_on_admin() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.role = 'admin' THEN
        UPDATE local_bootstrap_controls SET closed_at = COALESCE(closed_at, clock_timestamp()),
            token_digest = NULL, provisioned_at = NULL, expires_at = NULL
        WHERE organization_id = NEW.organization_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER organization_actor_roles_local_bootstrap_close BEFORE INSERT OR UPDATE OF role
ON organization_actor_roles FOR EACH ROW EXECUTE FUNCTION close_local_bootstrap_on_admin();

CREATE FUNCTION prevent_local_bootstrap_reopen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        RAISE EXCEPTION 'local bootstrap organization is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'local bootstrap is permanently closed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_bootstrap_controls_closed_guard BEFORE UPDATE ON local_bootstrap_controls
FOR EACH ROW EXECUTE FUNCTION prevent_local_bootstrap_reopen();

CREATE FUNCTION prevent_local_bootstrap_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'local bootstrap controls cannot be deleted' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER local_bootstrap_controls_delete_guard BEFORE DELETE ON local_bootstrap_controls
FOR EACH ROW EXECUTE FUNCTION prevent_local_bootstrap_delete();

CREATE FUNCTION prevent_local_credential_identity_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.organization_id, NEW.actor_id, NEW.username, NEW.provider_namespace)
        IS DISTINCT FROM (OLD.organization_id, OLD.actor_id, OLD.username, OLD.provider_namespace) THEN
        RAISE EXCEPTION 'local credential identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_credentials_identity_guard BEFORE UPDATE ON local_credentials
FOR EACH ROW EXECUTE FUNCTION prevent_local_credential_identity_change();

CREATE TABLE local_account_enrollments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL,
    provisioned_by UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind IN ('first_use', 'email_invitation')),
    email TEXT,
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
    consumed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (organization_id, actor_id) REFERENCES local_credentials (organization_id, actor_id) ON DELETE RESTRICT,
    CHECK (expires_at = created_at + interval '7 days'),
    CHECK ((kind = 'first_use' AND email IS NULL) OR (kind = 'email_invitation' AND email IS NOT NULL AND length(email) BETWEEN 3 AND 254)),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX local_account_enrollments_actor_idx ON local_account_enrollments (organization_id, actor_id);

CREATE FUNCTION enforce_local_enrollment_provisioner_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM actor_identities WHERE organization_id = NEW.organization_id AND actor_id = NEW.provisioned_by) THEN
        RAISE EXCEPTION 'enrollment provisioner is outside the organization' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_account_enrollments_provisioner_scope BEFORE INSERT ON local_account_enrollments
FOR EACH ROW EXECUTE FUNCTION enforce_local_enrollment_provisioner_scope();

CREATE FUNCTION prevent_local_enrollment_replay() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.organization_id, NEW.actor_id, NEW.provisioned_by, NEW.kind, NEW.email, NEW.token_digest, NEW.created_at, NEW.expires_at)
        IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.actor_id, OLD.provisioned_by, OLD.kind, OLD.email, OLD.token_digest, OLD.created_at, OLD.expires_at)
        OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)
        OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
        RAISE EXCEPTION 'local enrollment is immutable or already used' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_account_enrollments_replay_guard BEFORE UPDATE ON local_account_enrollments
FOR EACH ROW EXECUTE FUNCTION prevent_local_enrollment_replay();
