ALTER TABLE local_credentials ADD COLUMN auth_version BIGINT NOT NULL DEFAULT 1 CHECK (auth_version > 0);

CREATE TABLE local_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL,
    token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    auth_version BIGINT NOT NULL CHECK (auth_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    FOREIGN KEY (organization_id, actor_id) REFERENCES local_credentials(organization_id, actor_id) ON DELETE RESTRICT,
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '8 hours')
);
CREATE INDEX local_sessions_actor_idx ON local_sessions(organization_id, actor_id);
CREATE INDEX local_sessions_expiry_idx ON local_sessions(expires_at);

-- Fixed-size buckets deliberately trade occasional collisions for bounded
-- anonymous metadata. No username, network address, or credential is retained.
CREATE TABLE local_login_limits (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    bucket INTEGER NOT NULL CHECK (bucket BETWEEN -1 AND 255),
    window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 120),
    PRIMARY KEY (organization_id, bucket)
);
CREATE TABLE local_auth_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID,
    action TEXT NOT NULL CHECK (action IN ('login_succeeded', 'login_failed', 'login_limited', 'session_revoked', 'credentials_changed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX local_auth_audit_organization_created_idx ON local_auth_audit_events(organization_id, created_at);
CREATE TRIGGER local_auth_audit_immutable BEFORE UPDATE OR DELETE ON local_auth_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_admin_access_audit_mutation();
CREATE FUNCTION enforce_local_auth_audit_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.actor_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM actor_identities WHERE organization_id = NEW.organization_id AND actor_id = NEW.actor_id
    ) THEN
        RAISE EXCEPTION 'auth audit actor is outside organization' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_auth_audit_scope BEFORE INSERT ON local_auth_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_local_auth_audit_scope();

CREATE FUNCTION guard_local_session() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (NEW.id, NEW.organization_id, NEW.actor_id, NEW.token_digest, NEW.auth_version, NEW.created_at, NEW.expires_at)
            IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.actor_id, OLD.token_digest, OLD.auth_version, OLD.created_at, OLD.expires_at)
            OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
            RAISE EXCEPTION 'session identity and lifetime are immutable' USING ERRCODE = '55000';
        END IF;
    ELSE
        PERFORM 1 FROM local_credentials WHERE organization_id = NEW.organization_id AND actor_id = NEW.actor_id
            AND enabled AND password_hash IS NOT NULL AND auth_version = NEW.auth_version FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'session credential is unavailable' USING ERRCODE = '23503';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_sessions_guard BEFORE INSERT OR UPDATE ON local_sessions
FOR EACH ROW EXECUTE FUNCTION guard_local_session();

CREATE FUNCTION revoke_local_credential_sessions() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.enabled, NEW.password_hash, NEW.password_algorithm, NEW.password_version)
        IS DISTINCT FROM (OLD.enabled, OLD.password_hash, OLD.password_algorithm, OLD.password_version) THEN
        NEW.auth_version := OLD.auth_version + 1;
        UPDATE local_sessions SET revoked_at = clock_timestamp()
            WHERE organization_id = OLD.organization_id AND actor_id = OLD.actor_id AND revoked_at IS NULL;
        INSERT INTO local_auth_audit_events(organization_id, actor_id, action)
            VALUES (OLD.organization_id, OLD.actor_id, 'credentials_changed');
    ELSIF NEW.auth_version <> OLD.auth_version THEN
        RAISE EXCEPTION 'credential version is storage managed' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER local_credentials_session_revocation BEFORE UPDATE ON local_credentials
FOR EACH ROW EXECUTE FUNCTION revoke_local_credential_sessions();

CREATE FUNCTION local_actor_authentication_enabled(target_organization_id UUID, target_actor_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT NOT EXISTS (SELECT 1 FROM local_credentials WHERE actor_id = target_actor_id
        AND (organization_id <> target_organization_id OR NOT enabled OR password_hash IS NULL))
$$;

-- Preserve the current role policy exactly, adding credential eligibility to
-- REST, worker dispatch/effects and restart recovery through their shared SQL.
ALTER FUNCTION authorization_effective_project_role(UUID, UUID, UUID) RENAME TO authorization_effective_project_role_before_local_sessions;
CREATE FUNCTION authorization_effective_project_role(target_organization_id UUID, target_project_id UUID, target_actor_id UUID)
RETURNS TABLE(effective_role TEXT, enforcement TEXT, project_status TEXT) LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN local_actor_authentication_enabled(target_organization_id, target_actor_id) THEN effective_role ELSE NULL END,
        enforcement, project_status
    FROM authorization_effective_project_role_before_local_sessions(target_organization_id, target_project_id, target_actor_id)
$$;
ALTER FUNCTION authorization_allows_project(UUID, UUID, UUID, TEXT) RENAME TO authorization_allows_project_before_local_sessions;
CREATE FUNCTION authorization_allows_project(target_organization_id UUID, target_project_id UUID, target_actor_id UUID, operation TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT local_actor_authentication_enabled(target_organization_id, target_actor_id)
        AND authorization_allows_project_before_local_sessions(target_organization_id, target_project_id, target_actor_id, operation)
$$;
ALTER FUNCTION authorization_allows_organization(UUID, UUID, TEXT) RENAME TO authorization_allows_organization_before_local_sessions;
CREATE FUNCTION authorization_allows_organization(target_organization_id UUID, target_actor_id UUID, operation TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT local_actor_authentication_enabled(target_organization_id, target_actor_id)
        AND authorization_allows_organization_before_local_sessions(target_organization_id, target_actor_id, operation)
$$;

-- Local provenance is a server-generated durable UUID, never a username link.
CREATE FUNCTION trusted_actor_subject_matches(target_organization_id UUID, subject TEXT, target_actor_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT basic_auth_identity_matches(target_organization_id, subject, target_actor_id)
        OR (subject = 'actor:' || target_actor_id::text AND EXISTS (
            SELECT 1 FROM local_credentials WHERE organization_id = target_organization_id AND actor_id = target_actor_id))
$$;

-- Existing durable revocation triggers use this function for optimization work.
-- Preserve legacy experiment/task cancellation, and cancel local provenance too.
ALTER FUNCTION cancel_project_execution_admissions_for_actor(UUID, UUID, UUID)
    RENAME TO cancel_project_execution_admissions_for_actor_before_local_sessions;
CREATE FUNCTION cancel_project_execution_admissions_for_actor(target_organization_id UUID, target_project_id UUID, target_actor_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    PERFORM cancel_project_execution_admissions_for_actor_before_local_sessions(target_organization_id, target_project_id, target_actor_id);
    WITH cancelled AS (
        UPDATE prompt_optimization_jobs SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
            status = 'stopped', updated_at = now(), completed_at = now()
        WHERE project_id = target_project_id AND status IN ('queued', 'preparing', 'optimizing', 'evaluating')
            AND trusted_actor_subject_matches(target_organization_id, requested_by, target_actor_id)
        RETURNING id
    ) INSERT INTO prompt_optimization_events(job_id, status, detail)
        SELECT id, 'stopped', '{"reason":"authorization_revoked"}'::jsonb FROM cancelled;
END;
$$;
