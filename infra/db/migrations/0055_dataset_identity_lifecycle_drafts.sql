-- Stable Dataset identity and a shared optimistic-concurrency draft workspace.
ALTER TABLE datasets
    ADD COLUMN IF NOT EXISTS slug TEXT,
    ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS latest_published_version INTEGER,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS archived_by UUID;

DO $$
DECLARE row_record RECORD; base_slug TEXT; candidate_slug TEXT; suffix TEXT; collision INTEGER;
BEGIN
    FOR row_record IN SELECT id, project_id, name FROM datasets WHERE slug IS NULL ORDER BY project_id, id LOOP
        base_slug := trim(BOTH '-' FROM left(trim(BOTH '-' FROM regexp_replace(lower(row_record.name), '[^a-z0-9]+', '-', 'g')), 64));
        base_slug := COALESCE(NULLIF(base_slug, ''), 'dataset');
        candidate_slug := base_slug;
        IF EXISTS (SELECT 1 FROM datasets WHERE project_id = row_record.project_id AND slug = candidate_slug) THEN
            suffix := substring(replace(row_record.id::text, '-', '') FROM 1 FOR 12);
            candidate_slug := left(base_slug, 51) || '-' || suffix;
            collision := 2;
            WHILE EXISTS (SELECT 1 FROM datasets WHERE project_id = row_record.project_id AND slug = candidate_slug) LOOP
                candidate_slug := left(base_slug, 47) || '-' || suffix || '-' || collision::text;
                collision := collision + 1;
            END LOOP;
        END IF;
        UPDATE datasets SET slug = candidate_slug WHERE id = row_record.id;
    END LOOP;
END $$;

ALTER TABLE datasets ALTER COLUMN slug SET NOT NULL;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'datasets'::regclass AND conname = 'datasets_slug_format_check') THEN
        ALTER TABLE datasets ADD CONSTRAINT datasets_slug_format_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS datasets_project_slug_key ON datasets(project_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS datasets_project_id_id_key ON datasets(project_id, id);

CREATE TABLE IF NOT EXISTS dataset_item_input_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    dataset_id UUID NOT NULL,
    dataset_item_id UUID NOT NULL UNIQUE REFERENCES dataset_items(id) ON DELETE RESTRICT,
    original_input JSONB NOT NULL,
    reason TEXT NOT NULL CHECK (reason = 'input_not_object'),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT
);
INSERT INTO dataset_item_input_quarantine (project_id, dataset_id, dataset_item_id, original_input, reason)
SELECT d.project_id, i.dataset_id, i.id, i.input, 'input_not_object'
FROM dataset_items i
JOIN datasets d ON d.id = i.dataset_id
WHERE jsonb_typeof(i.input) <> 'object'
ON CONFLICT (dataset_item_id) DO NOTHING;
UPDATE dataset_items
SET input = jsonb_build_object('legacy_input', input)
WHERE jsonb_typeof(input) <> 'object';

CREATE TABLE IF NOT EXISTS dataset_tombstones (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    PRIMARY KEY (project_id, slug)
);
CREATE TABLE IF NOT EXISTS dataset_lifecycle_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    dataset_id UUID NOT NULL,
    slug TEXT NOT NULL,
    actor_id UUID NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('archived', 'restored')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dataset_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    dataset_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    schema JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schema) = 'object'),
    item_count INTEGER NOT NULL CHECK (item_count >= 0),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    created_via TEXT NOT NULL DEFAULT 'legacy_migration',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, version),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS dataset_version_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    dataset_version_id UUID NOT NULL,
    item_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    expected_output JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    source_trace_id TEXT,
    source_observation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_version_id, item_key),
    UNIQUE (dataset_version_id, position),
    FOREIGN KEY (project_id, dataset_version_id) REFERENCES dataset_versions(project_id, id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS dataset_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    dataset_id UUID NOT NULL,
    base_version INTEGER,
    schema JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(schema) = 'object'),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id),
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS dataset_draft_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL,
    draft_id UUID NOT NULL,
    item_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    expected_output JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    source_trace_id TEXT,
    source_observation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (draft_id, item_key),
    UNIQUE (draft_id, position),
    FOREIGN KEY (project_id, draft_id) REFERENCES dataset_drafts(project_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION prevent_dataset_snapshot_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'dataset snapshots are immutable' USING ERRCODE = '55000'; END $$;
CREATE OR REPLACE FUNCTION prevent_dataset_identity_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.slug <> OLD.slug OR NEW.project_id <> OLD.project_id THEN
        RAISE EXCEPTION 'dataset identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS datasets_identity_immutable ON datasets;
CREATE TRIGGER datasets_identity_immutable BEFORE UPDATE ON datasets FOR EACH ROW EXECUTE FUNCTION prevent_dataset_identity_mutation();
DROP TRIGGER IF EXISTS dataset_versions_immutable ON dataset_versions;
CREATE TRIGGER dataset_versions_immutable BEFORE UPDATE OR DELETE ON dataset_versions FOR EACH ROW EXECUTE FUNCTION prevent_dataset_snapshot_mutation();
DROP TRIGGER IF EXISTS dataset_version_items_immutable ON dataset_version_items;
CREATE TRIGGER dataset_version_items_immutable BEFORE UPDATE OR DELETE ON dataset_version_items FOR EACH ROW EXECUTE FUNCTION prevent_dataset_snapshot_mutation();
DROP TRIGGER IF EXISTS dataset_lifecycle_audit_immutable ON dataset_lifecycle_audit_events;
CREATE TRIGGER dataset_lifecycle_audit_immutable BEFORE UPDATE OR DELETE ON dataset_lifecycle_audit_events FOR EACH ROW EXECUTE FUNCTION prevent_dataset_snapshot_mutation();

WITH inserted_versions AS (
    INSERT INTO dataset_versions (project_id, dataset_id, version, item_count, content_hash)
    SELECT d.project_id, d.id, 1, count(i.id)::int,
      encode(digest(jsonb_build_object('schema', '{}'::jsonb, 'items', COALESCE(jsonb_agg(jsonb_build_object('item_key', i.id::text, 'input', i.input, 'expected_output', i.expected_output, 'metadata', i.metadata, 'source_trace_id', i.source_trace_id, 'source_observation_id', i.source_observation_id) ORDER BY i.created_at, i.id) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb))::text, 'sha256'), 'hex')
    FROM datasets d LEFT JOIN dataset_items i ON i.dataset_id = d.id
    WHERE d.latest_published_version IS NULL GROUP BY d.id
    RETURNING id, project_id, dataset_id
), snapshots AS (
    INSERT INTO dataset_version_items (project_id, dataset_version_id, item_key, position, input, expected_output, metadata, source_trace_id, source_observation_id)
    SELECT v.project_id, v.id, i.id::text, row_number() OVER (PARTITION BY v.id ORDER BY i.created_at, i.id) - 1, i.input, i.expected_output, i.metadata, i.source_trace_id, i.source_observation_id
    FROM inserted_versions v JOIN dataset_items i ON i.dataset_id = v.dataset_id
    RETURNING dataset_version_id
)
UPDATE datasets d SET latest_published_version = 1
WHERE d.latest_published_version IS NULL AND EXISTS (SELECT 1 FROM inserted_versions v WHERE v.dataset_id = d.id);
