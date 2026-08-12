-- Admin/User/Read-only is additive: existing Basic Auth deployments remain in
-- compatibility mode until an operator explicitly enables strict enforcement.
CREATE TABLE IF NOT EXISTS authorization_policy_settings (
    organization_id UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
    strict_enforcement BOOLEAN NOT NULL DEFAULT false,
    enabled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((strict_enforcement AND enabled_at IS NOT NULL) OR NOT strict_enforcement)
);

CREATE TABLE IF NOT EXISTS authorization_legacy_role_mapping (
    membership_scope TEXT NOT NULL CHECK (membership_scope IN ('organization', 'project')),
    legacy_role TEXT NOT NULL,
    effective_role TEXT NOT NULL CHECK (effective_role IN ('admin', 'user', 'read_only')),
    PRIMARY KEY (membership_scope, legacy_role)
);
INSERT INTO authorization_legacy_role_mapping (
    membership_scope,
    legacy_role,
    effective_role
) VALUES
    ('organization', 'owner', 'admin'),
    ('project', 'manager', 'user'),
    ('project', 'member', 'read_only')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS authorization_role_migration_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_table TEXT NOT NULL CHECK (source_table IN ('organization_memberships', 'project_memberships')),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID REFERENCES projects(id) ON DELETE RESTRICT,
    actor_subject TEXT NOT NULL,
    legacy_role TEXT NOT NULL,
    effective_role TEXT NOT NULL CHECK (effective_role IN ('admin', 'user', 'read_only')),
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS authorization_role_migration_audit_replay_key
    ON authorization_role_migration_audit (
        source_table,
        organization_id,
        COALESCE(project_id::text, ''),
        actor_subject,
        legacy_role,
        effective_role
    );

CREATE TABLE IF NOT EXISTS authorization_role_migration_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_table TEXT NOT NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID,
    actor_subject TEXT,
    reason TEXT NOT NULL CHECK (reason IN (
        'malformed_legacy_role',
        'orphaned_project_membership',
        'cross_organization_subject',
        'unmapped_legacy_subject'
    )),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS authorization_role_migration_quarantine_replay_key
    ON authorization_role_migration_quarantine (
        source_table,
        COALESCE(organization_id::text, ''),
        COALESCE(project_id::text, ''),
        COALESCE(actor_subject, ''),
        reason
    );

INSERT INTO authorization_policy_settings (organization_id)
SELECT id FROM organizations
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION provision_authorization_policy_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO authorization_policy_settings (organization_id)
    VALUES (NEW.id)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS organizations_authorization_policy_settings ON organizations;
CREATE TRIGGER organizations_authorization_policy_settings
AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION provision_authorization_policy_settings();

-- The legacy vocabulary is read only through these explicit mapping records.
INSERT INTO authorization_role_migration_audit (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    legacy_role,
    effective_role
)
SELECT membership_scope.source_table, membership.organization_id, NULL, membership.actor_subject, membership.role, mapping.effective_role
FROM organization_memberships AS membership
JOIN authorization_legacy_role_mapping AS mapping
  ON mapping.membership_scope = 'organization'
 AND mapping.legacy_role = membership.role
CROSS JOIN LATERAL (
    SELECT 'organization_memberships'::text AS source_table
) AS membership_scope
WHERE CASE
    WHEN btrim(membership.actor_subject) = ''
      OR normalize(membership.actor_subject, NFKC) !~ '^[ -~]+$' THEN false
    ELSE EXISTS (
        SELECT 1
        FROM actor_identities AS identity
        WHERE identity.organization_id = membership.organization_id
          AND identity.provider_namespace = 'basic:v1'
          AND identity.canonical_subject = basic_auth_canonical_subject(membership.actor_subject)
    )
END
ON CONFLICT DO NOTHING;

INSERT INTO authorization_role_migration_audit (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    legacy_role,
    effective_role
)
SELECT
    'project_memberships',
    membership.organization_id,
    membership.project_id,
    membership.actor_subject,
    membership.role,
    mapping.effective_role
FROM project_memberships AS membership
JOIN projects AS project
    ON project.id = membership.project_id
   AND project.organization_id = membership.organization_id
JOIN authorization_legacy_role_mapping AS mapping
    ON mapping.membership_scope = 'project'
   AND mapping.legacy_role = membership.role
JOIN actor_identities AS identity
    ON identity.organization_id = membership.organization_id
   AND identity.provider_namespace = 'basic:v1'
   AND CASE
       WHEN btrim(membership.actor_subject) = ''
         OR normalize(membership.actor_subject, NFKC) !~ '^[ -~]+$' THEN false
       ELSE identity.canonical_subject = basic_auth_canonical_subject(membership.actor_subject)
   END
ON CONFLICT DO NOTHING;

INSERT INTO authorization_role_migration_quarantine (
    source_table,
    organization_id,
    project_id,
    actor_subject,
    reason
)
SELECT 'organization_memberships', organization_id, NULL, actor_subject, 'malformed_legacy_role'
FROM organization_memberships
WHERE role NOT IN ('owner', 'member')
UNION ALL
SELECT 'project_memberships', organization_id, project_id, actor_subject, 'malformed_legacy_role'
FROM project_memberships
WHERE role NOT IN ('manager', 'member')
UNION ALL
SELECT
    'project_memberships',
    membership.organization_id,
    membership.project_id,
    membership.actor_subject,
    'orphaned_project_membership'
FROM project_memberships AS membership
LEFT JOIN projects AS project
    ON project.id = membership.project_id
   AND project.organization_id = membership.organization_id
WHERE project.id IS NULL
UNION ALL
SELECT
    'organization_memberships',
    quarantine.organization_id,
    NULL,
    quarantine.legacy_subject,
    'cross_organization_subject'
FROM actor_identity_backfill_quarantine AS quarantine
WHERE quarantine.source_table = 'organization_memberships'
  AND quarantine.reason = 'cross_organization_subject'
UNION ALL
SELECT
    'organization_memberships',
    membership.organization_id,
    NULL,
    membership.actor_subject,
    'unmapped_legacy_subject'
FROM organization_memberships AS membership
WHERE NOT EXISTS (
    SELECT 1
    FROM actor_identities AS identity
    WHERE identity.organization_id = membership.organization_id
      AND identity.provider_namespace = 'basic:v1'
      AND basic_auth_identity_matches(
          membership.organization_id,
          membership.actor_subject,
          identity.actor_id
      )
)
ON CONFLICT DO NOTHING;

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
        COALESCE(organization_mapping.effective_role, project_mapping.effective_role)
            AS effective_role,
        CASE WHEN settings.strict_enforcement THEN 'strict' ELSE 'compatibility' END AS enforcement,
        project.status AS project_status
    FROM projects AS project
    JOIN authorization_policy_settings AS settings
      ON settings.organization_id = project.organization_id
    LEFT JOIN organization_memberships AS organization_membership
      ON organization_membership.organization_id = project.organization_id
     AND basic_auth_identity_matches(
         project.organization_id,
         organization_membership.actor_subject,
         target_actor_id
     )
    LEFT JOIN project_memberships AS project_membership
      ON project_membership.project_id = project.id
     AND project_membership.organization_id = project.organization_id
     AND basic_auth_identity_matches(
         project.organization_id,
         project_membership.actor_subject,
         target_actor_id
     )
    LEFT JOIN authorization_legacy_role_mapping AS organization_mapping
      ON organization_mapping.membership_scope = 'organization'
     AND organization_mapping.legacy_role = organization_membership.role
    LEFT JOIN authorization_legacy_role_mapping AS project_mapping
      ON project_mapping.membership_scope = 'project'
     AND project_mapping.legacy_role = project_membership.role
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
                'product_read', 'product_write', 'execute', 'ingest', 'audit_read', 'project_manage', 'governed'
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
        FROM organization_memberships AS membership
        WHERE membership.organization_id = target_organization_id
          AND membership.role = 'owner'
          AND basic_auth_identity_matches(
              target_organization_id,
              membership.actor_subject,
              target_actor_id
          )
          AND operation IN ('organization_manage', 'destructive', 'governed')
    )
$$;

-- The existing legacy owner guard is the durable Admin guard because owner is
-- only mapped to Admin by authorization_effective_project_role above.
CREATE OR REPLACE FUNCTION prevent_final_workspace_role_removal() RETURNS trigger AS $$
BEGIN
    IF TG_TABLE_NAME = 'organization_memberships' THEN
        PERFORM 1 FROM organizations WHERE id = OLD.organization_id FOR UPDATE;
        IF TG_OP = 'UPDATE' AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
            RAISE EXCEPTION 'organization membership scope is immutable';
        END IF;
        IF OLD.role = 'owner'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND NOT EXISTS (
                SELECT 1 FROM organization_memberships
                WHERE organization_id = OLD.organization_id
                  AND actor_subject <> OLD.actor_subject
                  AND role = 'owner'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final organization Admin';
        END IF;
    END IF;

    IF TG_TABLE_NAME = 'project_memberships' THEN
        PERFORM 1 FROM projects WHERE id = OLD.project_id FOR UPDATE;
        IF TG_OP = 'UPDATE' AND (
            NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        ) THEN
            RAISE EXCEPTION 'project membership scope is immutable';
        END IF;
        IF OLD.role = 'manager'
            AND (TG_OP = 'DELETE' OR NEW.role <> OLD.role)
            AND EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id AND status = 'active')
            AND NOT EXISTS (
                SELECT 1 FROM project_memberships
                WHERE project_id = OLD.project_id
                  AND actor_subject <> OLD.actor_subject
                  AND role = 'manager'
            ) THEN
            RAISE EXCEPTION 'cannot remove or demote the final active project User';
        END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION authorization_role_migration_readiness(
    target_organization_id UUID
) RETURNS TABLE (
    strict_enforcement BOOLEAN,
    unresolved_quarantine_count BIGINT,
    has_admin BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        COALESCE(settings.strict_enforcement, false) AS strict_enforcement,
        (
            SELECT count(*)
            FROM authorization_role_migration_quarantine AS quarantine
            WHERE quarantine.organization_id = target_organization_id
              AND quarantine.resolved_at IS NULL
        ) AS unresolved_quarantine_count,
        EXISTS (
            SELECT 1
            FROM organization_memberships AS membership
            JOIN actor_identities AS identity
              ON identity.organization_id = membership.organization_id
             AND identity.provider_namespace = 'basic:v1'
             AND basic_auth_identity_matches(
                 membership.organization_id,
                 membership.actor_subject,
                 identity.actor_id
             )
            WHERE membership.organization_id = target_organization_id
              AND membership.role = 'owner'
        ) AS has_admin
    FROM organizations AS organization
    LEFT JOIN authorization_policy_settings AS settings
      ON settings.organization_id = organization.id
    WHERE organization.id = target_organization_id
$$;

CREATE OR REPLACE FUNCTION enable_admin_user_read_only_enforcement(
    target_organization_id UUID
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM 1 FROM organizations WHERE id = target_organization_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'organization is not available';
    END IF;

    INSERT INTO authorization_policy_settings (organization_id)
    VALUES (target_organization_id)
    ON CONFLICT DO NOTHING;
    PERFORM 1
    FROM authorization_policy_settings
    WHERE organization_id = target_organization_id
    FOR UPDATE;

    IF EXISTS (
        SELECT 1
        FROM authorization_role_migration_quarantine
        WHERE organization_id = target_organization_id
          AND resolved_at IS NULL
    ) THEN
        RAISE EXCEPTION 'unresolved authorization role migration quarantine';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM organization_memberships AS membership
        WHERE membership.organization_id = target_organization_id
          AND membership.role = 'owner'
          AND EXISTS (
              SELECT 1
              FROM actor_identities AS identity
              WHERE identity.organization_id = target_organization_id
                AND identity.provider_namespace = 'basic:v1'
                AND basic_auth_identity_matches(
                    target_organization_id,
                    membership.actor_subject,
                    identity.actor_id
                )
          )
    ) THEN
        RAISE EXCEPTION 'cannot enable strict enforcement without an Admin';
    END IF;

    UPDATE authorization_policy_settings
    SET strict_enforcement = true,
        enabled_at = COALESCE(enabled_at, now()),
        updated_at = now()
    WHERE organization_id = target_organization_id;
END;
$$;
