-- Durable actor roles and grants supersede the legacy subject-keyed tables for
-- authorization decisions. Legacy rows remain only to preserve historical API
-- and audit provenance during the staged Basic Auth rollout.
CREATE TABLE IF NOT EXISTS organization_actor_roles (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'read_only')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, actor_id)
);

CREATE TABLE IF NOT EXISTS project_actor_grants (
    project_id UUID NOT NULL,
    organization_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'read_only')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, actor_id),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS project_actor_grants_actor_project_idx
    ON project_actor_grants (actor_id, project_id);

-- This audit has no credential, claim, username, request body, or application
-- content columns. Project UUIDs are retained after permanent deletion.
CREATE TABLE IF NOT EXISTS admin_access_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID,
    actor_id UUID NOT NULL,
    target_actor_id UUID,
    action TEXT NOT NULL CHECK (action IN (
        'actor_identity_linked',
        'bootstrap_owner_granted',
        'organization_role_set',
        'project_grant_set',
        'project_grant_revoked',
        'recovery_succeeded',
        'recovery_denied',
        'recovery_rate_limited'
    )),
    correlation_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_access_audit_events_organization_created_idx
    ON admin_access_audit_events (organization_id, created_at, id);

-- Recovery grants no token and stores no secret. A durable row serializes a
-- successful recovery and records the expiry of its cooldown window.
CREATE TABLE IF NOT EXISTS admin_recovery_controls (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
    last_attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_recovered_at TIMESTAMPTZ,
    cooldown_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (cooldown_expires_at IS NULL OR cooldown_expires_at >= last_attempted_at)
);

CREATE OR REPLACE FUNCTION audit_admin_access_event(
    target_organization_id UUID,
    target_project_id UUID,
    initiating_actor_id UUID,
    affected_actor_id UUID,
    event_action TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO admin_access_audit_events (
        organization_id,
        project_id,
        actor_id,
        target_actor_id,
        action,
        correlation_id
    ) VALUES (
        target_organization_id,
        target_project_id,
        initiating_actor_id,
        affected_actor_id,
        event_action,
        gen_random_uuid()
    );
END;
$$;

CREATE OR REPLACE FUNCTION enforce_organization_actor_role_identity_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.actor_id = NEW.actor_id
          AND identity.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'organization role actor identity is outside the organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_actor_roles_identity_scope
    ON organization_actor_roles;
CREATE TRIGGER organization_actor_roles_identity_scope
BEFORE INSERT OR UPDATE OF organization_id, actor_id ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION enforce_organization_actor_role_identity_scope();

CREATE OR REPLACE FUNCTION enforce_project_actor_grant_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    organization_role TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM actor_identities identity
        WHERE identity.actor_id = NEW.actor_id
          AND identity.organization_id = NEW.organization_id
    ) THEN
        RAISE EXCEPTION 'project grant actor identity is outside the organization'
            USING ERRCODE = '23503';
    END IF;
    SELECT role INTO organization_role
    FROM organization_actor_roles
    WHERE organization_id = NEW.organization_id
      AND actor_id = NEW.actor_id
    FOR UPDATE;
    IF organization_role IS NULL OR organization_role NOT IN ('user', 'read_only') THEN
        RAISE EXCEPTION 'project grants require a non-Admin organization role'
            USING ERRCODE = '23503';
    END IF;
    IF NEW.role = 'user' AND organization_role = 'read_only' THEN
        RAISE EXCEPTION 'project grant exceeds the target organization role'
            USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM projects project
        WHERE project.id = NEW.project_id
          AND project.organization_id = NEW.organization_id
          AND project.status = 'active'
    ) THEN
        RAISE EXCEPTION 'project grant requires an active project in the organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_actor_grants_scope ON project_actor_grants;
CREATE TRIGGER project_actor_grants_scope
BEFORE INSERT OR UPDATE OF project_id, organization_id, actor_id ON project_actor_grants
FOR EACH ROW EXECUTE FUNCTION enforce_project_actor_grant_scope();

CREATE OR REPLACE FUNCTION prevent_final_admin_role_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin') THEN
        -- The target role row is locked before this BEFORE ROW trigger runs.
        -- The organization advisory lock serializes concurrent final-Admin
        -- removals without inverting membership/project/audit lock ordering.
        PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text, 51));
        IF NOT EXISTS (
            SELECT 1
            FROM organization_actor_roles role
            WHERE role.organization_id = OLD.organization_id
              AND role.actor_id <> OLD.actor_id
              AND role.role = 'admin'
              AND EXISTS (
                  SELECT 1
                  FROM actor_identities identity
                  WHERE identity.organization_id = role.organization_id
                    AND identity.actor_id = role.actor_id
              )
        ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final organization Admin';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS organization_actor_roles_final_admin_guard
    ON organization_actor_roles;
CREATE TRIGGER organization_actor_roles_final_admin_guard
BEFORE DELETE OR UPDATE OF role ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION prevent_final_admin_role_removal();

CREATE OR REPLACE FUNCTION fence_durable_actor_role_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_project_id UUID;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.role <> 'admin' AND NEW.role <> 'admin' THEN
        RETURN NEW;
    END IF;
    PERFORM 1
    FROM project_memberships membership
    JOIN actor_identities identity
      ON identity.organization_id = membership.organization_id
     AND identity.actor_id = OLD.actor_id
     AND identity.provider_namespace = 'basic:v1'
     AND membership.actor_subject = identity.canonical_subject
    WHERE membership.organization_id = OLD.organization_id
    ORDER BY membership.project_id
    FOR UPDATE OF membership;
    PERFORM 1
    FROM project_actor_grants
    WHERE organization_id = OLD.organization_id
      AND actor_id = OLD.actor_id
    ORDER BY project_id
    FOR UPDATE;
    -- PostgreSQL locks the target role row before this trigger. Project rows
    -- and then audit UUID locks preserve the mutation ordering.
    PERFORM 1
    FROM projects
    WHERE organization_id = OLD.organization_id
    ORDER BY id
    FOR UPDATE;
    FOR target_project_id IN
        SELECT id FROM projects WHERE organization_id = OLD.organization_id ORDER BY id
    LOOP
        PERFORM lock_project_audit_provenance(target_project_id);
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS organization_actor_roles_revocation_fence
    ON organization_actor_roles;
DROP TRIGGER IF EXISTS organization_actor_roles_00_revocation_fence
    ON organization_actor_roles;
CREATE TRIGGER organization_actor_roles_00_revocation_fence
BEFORE DELETE OR UPDATE OF role ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION fence_durable_actor_role_revocation();

CREATE OR REPLACE FUNCTION enforce_organization_actor_role_grant_ceiling()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.role = 'read_only' AND EXISTS (
        SELECT 1
        FROM project_actor_grants project_grant
        WHERE project_grant.organization_id = NEW.organization_id
          AND project_grant.actor_id = NEW.actor_id
          AND project_grant.role = 'user'
        FOR UPDATE
    ) THEN
        RAISE EXCEPTION 'organization role cannot be Read-only while User project grants exist';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organization_actor_roles_01_grant_ceiling
    ON organization_actor_roles;
CREATE TRIGGER organization_actor_roles_01_grant_ceiling
BEFORE UPDATE OF role ON organization_actor_roles
FOR EACH ROW EXECUTE FUNCTION enforce_organization_actor_role_grant_ceiling();

CREATE OR REPLACE FUNCTION fence_durable_project_grant_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.role = NEW.role THEN
        RETURN NEW;
    END IF;
    PERFORM 1 FROM projects WHERE id = OLD.project_id FOR UPDATE;
    PERFORM lock_project_audit_provenance(OLD.project_id);
    RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS project_actor_grants_revocation_fence ON project_actor_grants;
DROP TRIGGER IF EXISTS project_actor_grants_00_revocation_fence ON project_actor_grants;
CREATE TRIGGER project_actor_grants_00_revocation_fence
BEFORE DELETE OR UPDATE OF role ON project_actor_grants
FOR EACH ROW EXECUTE FUNCTION fence_durable_project_grant_revocation();

CREATE OR REPLACE FUNCTION prevent_final_admin_identity_unlink()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM organization_actor_roles role
        WHERE role.organization_id = OLD.organization_id
          AND role.actor_id = OLD.actor_id
          AND role.role = 'admin'
    ) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(OLD.organization_id::text, 51));
        IF NOT EXISTS (
            SELECT 1
            FROM organization_actor_roles role
            WHERE role.organization_id = OLD.organization_id
              AND role.role = 'admin'
              AND EXISTS (
                  SELECT 1
                  FROM actor_identities identity
                  WHERE identity.organization_id = role.organization_id
                    AND identity.actor_id = role.actor_id
                    AND NOT (
                        identity.actor_id = OLD.actor_id
                        AND identity.provider_namespace = OLD.provider_namespace
                    )
              )
        ) THEN
            RAISE EXCEPTION 'cannot unlink the final organization Admin identity';
        END IF;
    END IF;
    RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS actor_identities_final_admin_unlink_guard ON actor_identities;
CREATE TRIGGER actor_identities_final_admin_unlink_guard
BEFORE DELETE ON actor_identities
FOR EACH ROW EXECUTE FUNCTION prevent_final_admin_identity_unlink();

CREATE OR REPLACE FUNCTION prevent_admin_access_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'admin access audit events are append-only'
        USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS admin_access_audit_events_immutable
    ON admin_access_audit_events;
CREATE TRIGGER admin_access_audit_events_immutable
BEFORE UPDATE OR DELETE ON admin_access_audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_admin_access_audit_mutation();

CREATE OR REPLACE FUNCTION enforce_admin_access_audit_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.project_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM projects project
        WHERE project.id = NEW.project_id
          AND project.organization_id = NEW.organization_id
        FOR KEY SHARE
    ) THEN
        RAISE EXCEPTION 'admin access audit project belongs to another organization'
            USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS admin_access_audit_events_tenant_scope
    ON admin_access_audit_events;
CREATE TRIGGER admin_access_audit_events_tenant_scope
BEFORE INSERT ON admin_access_audit_events
FOR EACH ROW EXECUTE FUNCTION enforce_admin_access_audit_scope();

CREATE OR REPLACE FUNCTION audit_actor_identity_link()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO admin_access_audit_events (
        organization_id,
        actor_id,
        target_actor_id,
        action,
        correlation_id
    ) VALUES (
        NEW.organization_id,
        NEW.actor_id,
        NEW.actor_id,
        'actor_identity_linked',
        gen_random_uuid()
    );
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS actor_identities_admin_access_audit ON actor_identities;
CREATE TRIGGER actor_identities_admin_access_audit
AFTER INSERT ON actor_identities
FOR EACH ROW EXECUTE FUNCTION audit_actor_identity_link();

INSERT INTO organization_actor_roles (organization_id, actor_id, role)
SELECT
    membership.organization_id,
    identity.actor_id,
    CASE WHEN membership.role = 'owner' THEN 'admin' ELSE 'user' END
FROM organization_memberships membership
JOIN actor_identities identity
  ON identity.organization_id = membership.organization_id
 AND identity.provider_namespace = 'basic:v1'
 AND basic_auth_identity_matches(
     membership.organization_id,
     membership.actor_subject,
     identity.actor_id
 )
ON CONFLICT (organization_id, actor_id) DO UPDATE
SET role = CASE
    WHEN organization_actor_roles.role = 'admin' OR EXCLUDED.role = 'admin'
        THEN 'admin'
    ELSE organization_actor_roles.role
END,
updated_at = now()
WHERE organization_actor_roles.role IS DISTINCT FROM CASE
    WHEN organization_actor_roles.role = 'admin' OR EXCLUDED.role = 'admin'
        THEN 'admin'
    ELSE organization_actor_roles.role
END;

INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
SELECT
    membership.project_id,
    membership.organization_id,
    identity.actor_id,
    CASE WHEN membership.role = 'manager' THEN 'user' ELSE 'read_only' END
FROM project_memberships membership
JOIN projects project
  ON project.id = membership.project_id
 AND project.organization_id = membership.organization_id
 AND project.status = 'active'
JOIN organization_memberships organization_membership
  ON organization_membership.organization_id = membership.organization_id
 AND organization_membership.actor_subject = membership.actor_subject
 AND organization_membership.role <> 'owner'
JOIN actor_identities identity
  ON identity.organization_id = membership.organization_id
 AND identity.provider_namespace = 'basic:v1'
 AND basic_auth_identity_matches(
     membership.organization_id,
     membership.actor_subject,
     identity.actor_id
 )
ON CONFLICT (project_id, actor_id) DO UPDATE
SET role = EXCLUDED.role,
updated_at = now()
WHERE project_actor_grants.role IS DISTINCT FROM EXCLUDED.role;

CREATE OR REPLACE FUNCTION authorization_effective_project_role(
    target_organization_id UUID,
    target_project_id UUID,
    target_actor_id UUID
) RETURNS TABLE (
    effective_role TEXT,
    enforcement TEXT,
    project_status TEXT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        CASE
            WHEN EXISTS (
                SELECT 1
                FROM actor_identities worker
                WHERE worker.actor_id = target_actor_id
                  AND worker.organization_id = project.organization_id
                  AND worker.provider_namespace = 'internal:evaluation-worker:v1'
                  AND worker.canonical_subject = project.organization_id::text
            ) THEN 'admin'
            WHEN organization_role.role = 'admin' THEN 'admin'
            ELSE project_grant.role
        END AS effective_role,
        CASE WHEN settings.strict_enforcement THEN 'strict' ELSE 'compatibility' END AS enforcement,
        project.status AS project_status
    FROM projects AS project
    JOIN authorization_policy_settings AS settings
      ON settings.organization_id = project.organization_id
    LEFT JOIN organization_actor_roles AS organization_role
      ON organization_role.organization_id = project.organization_id
     AND organization_role.actor_id = target_actor_id
    LEFT JOIN project_actor_grants AS project_grant
      ON project_grant.project_id = project.id
     AND project_grant.organization_id = project.organization_id
     AND project_grant.actor_id = target_actor_id
    WHERE project.id = target_project_id
      AND project.organization_id = target_organization_id
$$;

CREATE OR REPLACE FUNCTION authorization_allows_project(
    target_organization_id UUID,
    target_project_id UUID,
    target_actor_id UUID,
    operation TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    WITH decision AS (
        SELECT *
        FROM authorization_effective_project_role(
            target_organization_id,
            target_project_id,
            target_actor_id
        )
    )
    SELECT COALESCE((
        CASE
            WHEN effective_role IS NULL THEN false
            WHEN project_status <> 'active' THEN
                (effective_role = 'admin'
                 AND operation IN ('audit_read', 'project_manage', 'destructive'))
                OR (enforcement = 'compatibility'
                    AND effective_role = 'user'
                    AND operation IN ('project_manage', 'destructive'))
            WHEN effective_role = 'admin' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest', 'audit_read',
                'governed', 'destructive', 'project_manage'
            )
            WHEN enforcement = 'compatibility' AND effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest', 'audit_read',
                'project_manage', 'governed'
            )
            WHEN effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest', 'audit_read'
            )
            WHEN enforcement = 'compatibility' AND effective_role = 'read_only' THEN operation IN (
                'product_read', 'product_write', 'execute', 'ingest'
            )
            WHEN effective_role = 'read_only' THEN operation IN ('product_read', 'audit_read')
            ELSE false
        END
    ), false)
    FROM decision
$$;

CREATE OR REPLACE FUNCTION authorization_allows_organization(
    target_organization_id UUID,
    target_actor_id UUID,
    operation TEXT
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM organization_actor_roles AS membership
        WHERE membership.organization_id = target_organization_id
          AND membership.actor_id = target_actor_id
          AND membership.role = 'admin'
          AND operation IN ('organization_manage', 'destructive', 'governed')
    )
$$;

CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM project_authorization_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM project_lifecycle_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM governance_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM admin_access_audit_events WHERE project_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'project UUID has retained audit provenance'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;
