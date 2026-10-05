-- Project grants are retired in favor of organization-wide role access. Keep the
-- historical table and audit rows intact for migration provenance, but remove
-- every live grant so it cannot be mistaken for an active authorization record.
DELETE FROM project_actor_grants;

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
            WHEN NOT local_actor_authentication_enabled(project.organization_id, target_actor_id) THEN NULL
            WHEN EXISTS (
                SELECT 1
                FROM actor_identities worker
                WHERE worker.actor_id = target_actor_id
                  AND worker.organization_id = project.organization_id
                  AND worker.provider_namespace = 'internal:evaluation-worker:v1'
                  AND worker.canonical_subject = project.organization_id::text
            ) THEN 'admin'
            ELSE organization_role.role
        END AS effective_role,
        CASE WHEN settings.strict_enforcement THEN 'strict' ELSE 'compatibility' END AS enforcement,
        project.status AS project_status
    FROM projects AS project
    JOIN authorization_policy_settings AS settings
      ON settings.organization_id = project.organization_id
    LEFT JOIN organization_actor_roles AS organization_role
      ON organization_role.organization_id = project.organization_id
     AND organization_role.actor_id = target_actor_id
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
        SELECT * FROM authorization_effective_project_role(
            target_organization_id, target_project_id, target_actor_id
        )
    )
    SELECT COALESCE((
        CASE
            WHEN effective_role IS NULL THEN false
            WHEN project_status <> 'active' THEN
                effective_role = 'admin'
                AND operation IN ('audit_read', 'project_manage', 'destructive')
            WHEN effective_role = 'admin' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read',
                'governed', 'release_gate_manage', 'destructive', 'project_manage'
            )
            WHEN effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read'
            )
            WHEN effective_role = 'read_only' THEN operation IN ('product_read', 'audit_read')
            ELSE false
        END
    ), false)
    FROM decision
$$;
