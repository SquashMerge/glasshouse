-- Astraea Postgres migrations: 0019_organizations
-- Organizations are the top-level tenant boundary. Existing single-tenant
-- installations are assigned to the deterministic default organization.

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO organizations (id, name, slug)
VALUES (
    '00000000-0000-4000-8000-000000000001',
    'Default Organization',
    'default'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE projects
SET organization_id = '00000000-0000-4000-8000-000000000001'
WHERE organization_id IS NULL;

ALTER TABLE projects
    ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'projects_organization_id_fkey'
    ) THEN
        ALTER TABLE projects
            ADD CONSTRAINT projects_organization_id_fkey
            FOREIGN KEY (organization_id)
            REFERENCES organizations(id)
            ON DELETE RESTRICT;
    END IF;
END
$$;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS projects_organization_slug_key
    ON projects(organization_id, slug);
