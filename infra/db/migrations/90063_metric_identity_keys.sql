CREATE TABLE IF NOT EXISTS project_metric_identity_keys (
    project_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    secret_key BYTEA NOT NULL DEFAULT gen_random_bytes(32)
        CHECK (octet_length(secret_key) = 32),
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE CASCADE
);

INSERT INTO project_metric_identity_keys (project_id, organization_id)
SELECT id, organization_id FROM projects
ON CONFLICT (project_id) DO NOTHING;

CREATE OR REPLACE FUNCTION glasshouse_initialize_metric_identity_key()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    INSERT INTO public.project_metric_identity_keys (project_id, organization_id)
    VALUES (NEW.id, NEW.organization_id)
    ON CONFLICT (project_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS glasshouse_metric_identity_key ON projects;
CREATE TRIGGER glasshouse_metric_identity_key AFTER INSERT ON projects
FOR EACH ROW EXECUTE FUNCTION glasshouse_initialize_metric_identity_key();
