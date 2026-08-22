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
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read',
                'governed', 'destructive', 'project_manage'
            )
            WHEN enforcement = 'compatibility' AND effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read',
                'project_manage', 'governed'
            )
            WHEN effective_role = 'user' THEN operation IN (
                'product_read', 'product_write', 'curation_write', 'execute', 'ingest', 'audit_read'
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

CREATE OR REPLACE FUNCTION require_dataset_lifecycle_audit_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM datasets
        WHERE id = NEW.dataset_id
          AND project_id = NEW.project_id
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit provenance is invalid' USING ERRCODE = '23503';
    END IF;
    IF NOT authorization_allows_project(
        NEW.organization_id,
        NEW.project_id,
        NEW.actor_id,
        CASE WHEN NEW.event_type = 'archived' THEN 'destructive' ELSE 'curation_write' END
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit actor is not authorized' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$$;
