BEGIN;
DO $$
DECLARE
    org UUID := gen_random_uuid();
    project UUID := gen_random_uuid();
    other_org UUID;
    key BYTEA;
BEGIN
    IF EXISTS (
        SELECT 1 FROM projects p LEFT JOIN project_metric_identity_keys k
        ON k.project_id = p.id AND k.organization_id = p.organization_id
        WHERE k.secret_key IS NULL OR octet_length(k.secret_key) <> 32
    ) THEN
        RAISE EXCEPTION 'existing Project metric keys were not backfilled';
    END IF;
    WITH inserted AS (
        INSERT INTO organizations (id, name, slug, default_project_id)
        VALUES (org, 'Metric identity fixture', org::text, project) RETURNING id
    ) INSERT INTO projects (id, organization_id, name, slug)
      SELECT project, id, 'Default', 'default' FROM inserted;
    SELECT secret_key INTO key FROM project_metric_identity_keys WHERE project_id = project;
    IF key IS NULL OR octet_length(key) <> 32 THEN
        RAISE EXCEPTION 'new Project did not receive a metric key';
    END IF;
    BEGIN
        UPDATE project_metric_identity_keys SET secret_key = NULL WHERE project_id = project;
        RAISE EXCEPTION 'NULL metric key accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    BEGIN
        UPDATE project_metric_identity_keys SET secret_key = decode('00', 'hex') WHERE project_id = project;
        RAISE EXCEPTION 'short metric key accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SELECT id INTO other_org FROM organizations WHERE id <> org LIMIT 1;
    IF other_org IS NULL THEN
        RAISE EXCEPTION 'metric key scope fixture requires an existing Organization';
    END IF;
    BEGIN
        UPDATE project_metric_identity_keys SET organization_id = other_org WHERE project_id = project;
        RAISE EXCEPTION 'unscoped metric key accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;
ROLLBACK;
