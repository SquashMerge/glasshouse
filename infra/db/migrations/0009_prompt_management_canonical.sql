-- Glasshouse Postgres migrations: 0009_prompt_management_canonical

DO $$
DECLARE
    invalid_prompt_ids TEXT;
BEGIN
    SELECT string_agg(prompt_id::text, ', ' ORDER BY prompt_id::text)
    INTO invalid_prompt_ids
    FROM (
        SELECT DISTINCT p.id AS prompt_id
        FROM prompts AS p
        LEFT JOIN prompt_versions AS v ON v.prompt_id = p.id
        WHERE v.id IS NULL
            OR jsonb_typeof(v.messages) IS DISTINCT FROM 'array'
            OR CASE
                WHEN jsonb_typeof(v.messages) IS NOT DISTINCT FROM 'array' THEN jsonb_array_length(v.messages) <> 1
                ELSE false
            END
            OR jsonb_typeof(v.messages->0) IS DISTINCT FROM 'object'
            OR jsonb_typeof(v.messages->0->'role') IS DISTINCT FROM 'string'
            OR COALESCE(v.messages->0->>'role' NOT IN ('system', 'user'), true)
            OR jsonb_typeof(v.messages->0->'content') IS DISTINCT FROM 'string'
            OR EXISTS (
                SELECT 1
                FROM prompt_versions AS other_version
                WHERE other_version.prompt_id = p.id
                    AND other_version.messages->0->>'role' IS DISTINCT FROM v.messages->0->>'role'
            )
    ) AS invalid_prompts;

    IF invalid_prompt_ids IS NOT NULL THEN
        RAISE EXCEPTION 'prompt canonicalization preflight failed for prompt UUIDs: %', invalid_prompt_ids
            USING ERRCODE = '23514';
    END IF;
END
$$;

ALTER TABLE prompts ADD COLUMN IF NOT EXISTS role TEXT;

DROP INDEX IF EXISTS prompts_project_slug_key;
ALTER TABLE prompts ALTER COLUMN slug DROP NOT NULL;
UPDATE prompts SET slug = NULL;

DO $$
DECLARE
    prompt_row RECORD;
    base_slug TEXT;
    candidate_slug TEXT;
    id_suffix TEXT;
    collision_number INTEGER;
BEGIN
    FOR prompt_row IN
        SELECT id, project_id, name
        FROM prompts
        ORDER BY project_id, id
    LOOP
        base_slug := trim(BOTH '-' FROM regexp_replace(lower(prompt_row.name), '[^a-z0-9]+', '-', 'g'));
        base_slug := trim(BOTH '-' FROM left(COALESCE(NULLIF(base_slug, ''), 'prompt'), 64));
        base_slug := COALESCE(NULLIF(base_slug, ''), 'prompt');
        candidate_slug := base_slug;

        IF EXISTS (
            SELECT 1
            FROM prompts
            WHERE project_id = prompt_row.project_id AND slug = candidate_slug
        ) THEN
            id_suffix := substring(replace(prompt_row.id::text, '-', '') FROM 1 FOR 12);
            candidate_slug := trim(BOTH '-' FROM left(base_slug, 64 - length(id_suffix) - 1)) || '-' || id_suffix;
            collision_number := 1;

            WHILE EXISTS (
                SELECT 1
                FROM prompts
                WHERE project_id = prompt_row.project_id AND slug = candidate_slug
            ) LOOP
                candidate_slug := trim(BOTH '-' FROM left(
                    base_slug,
                    64 - length(id_suffix) - length(collision_number::text) - 2
                )) || '-' || id_suffix || '-' || collision_number::text;
                collision_number := collision_number + 1;
            END LOOP;
        END IF;

        UPDATE prompts
        SET slug = candidate_slug
        WHERE id = prompt_row.id;
    END LOOP;
END
$$;

ALTER TABLE prompts ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS prompts_project_slug_key ON prompts(project_id, slug);

ALTER TABLE prompt_versions DISABLE TRIGGER prompt_versions_immutable;

UPDATE prompts AS p
SET role = (
    SELECT v.messages->0->>'role'
    FROM prompt_versions AS v
    WHERE v.prompt_id = p.id
    ORDER BY v.version
    LIMIT 1
);

UPDATE prompt_versions
SET content = messages->0->>'content',
    metadata = settings,
    change_message = CASE
        WHEN change_message IS NULL OR change_message !~ '[^[:space:]]' THEN
            CASE WHEN version = 1 THEN 'Initial version' ELSE 'Migrated version ' || version::text END
        ELSE change_message
    END,
    content_hash = prompt_version_content_hash(messages, model, settings);

ALTER TABLE prompt_versions ENABLE TRIGGER prompt_versions_immutable;

ALTER TABLE prompts ALTER COLUMN role SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompts'::regclass
            AND conname = 'prompts_role_check'
    ) THEN
        ALTER TABLE prompts
            ADD CONSTRAINT prompts_role_check CHECK (role IN ('system', 'user'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompts'::regclass
            AND conname = 'prompts_slug_canonical_check'
    ) THEN
        ALTER TABLE prompts
            ADD CONSTRAINT prompts_slug_canonical_check
            CHECK (char_length(slug) <= 64 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION prompt_version_messages_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN false
        ELSE COALESCE(
            jsonb_array_length(value) = 1
            AND jsonb_typeof(value->0) IS NOT DISTINCT FROM 'object'
            AND jsonb_typeof(value->0->'role') IS NOT DISTINCT FROM 'string'
            AND value->0->>'role' IN ('system', 'user')
            AND jsonb_typeof(value->0->'content') IS NOT DISTINCT FROM 'string',
            false
        )
    END
$$;

CREATE OR REPLACE FUNCTION prompt_version_role_matches_prompt()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT prompt_version_messages_valid(NEW.messages) THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompts
        WHERE id = NEW.prompt_id
            AND role = NEW.messages->0->>'role'
    ) THEN
        RAISE EXCEPTION 'prompt version role must match prompt role' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS prompt_versions_role_matches_prompt ON prompt_versions;
CREATE TRIGGER prompt_versions_role_matches_prompt
BEFORE INSERT ON prompt_versions
FOR EACH ROW
EXECUTE FUNCTION prompt_version_role_matches_prompt();

CREATE OR REPLACE FUNCTION prevent_prompt_role_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'prompt roles are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS prompts_role_immutable ON prompts;
CREATE TRIGGER prompts_role_immutable
BEFORE UPDATE OF role ON prompts
FOR EACH ROW
EXECUTE FUNCTION prevent_prompt_role_update();

CREATE TABLE IF NOT EXISTS prompt_tombstones (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    slug TEXT NOT NULL,
    PRIMARY KEY (project_id, slug)
);

CREATE OR REPLACE FUNCTION prevent_prompt_tombstone_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'prompt tombstones are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS prompt_tombstones_immutable ON prompt_tombstones;
CREATE TRIGGER prompt_tombstones_immutable
BEFORE UPDATE OR DELETE ON prompt_tombstones
FOR EACH ROW
EXECUTE FUNCTION prevent_prompt_tombstone_mutation();

CREATE TABLE IF NOT EXISTS prompt_deletion_audit (
    project_id UUID NOT NULL,
    prompt_id UUID NOT NULL,
    slug TEXT NOT NULL,
    deleted_by TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_version_count INTEGER NOT NULL
);

CREATE OR REPLACE FUNCTION prevent_prompt_deletion_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'prompt deletion audit rows are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS prompt_deletion_audit_immutable ON prompt_deletion_audit;
CREATE TRIGGER prompt_deletion_audit_immutable
BEFORE UPDATE OR DELETE ON prompt_deletion_audit
FOR EACH ROW
EXECUTE FUNCTION prevent_prompt_deletion_audit_mutation();

ALTER TABLE prompt_labels DROP CONSTRAINT IF EXISTS prompt_labels_label_format_check;

INSERT INTO prompt_labels (project_id, prompt_id, label, version_id)
SELECT
    q.original_project_id,
    q.original_prompt_id,
    q.original_label,
    q.original_version_id
FROM prompt_label_quarantine AS q
INNER JOIN prompts AS p
    ON p.id = q.original_prompt_id
    AND p.project_id = q.original_project_id
INNER JOIN prompt_versions AS v
    ON v.id = q.original_version_id
    AND v.prompt_id = q.original_prompt_id
WHERE q.reason = 'invalid_label_format'
    AND q.original_label ~ '^[a-z][a-z0-9_-]{0,63}$'
    AND q.original_label <> 'latest'
ON CONFLICT (project_id, prompt_id, label) DO NOTHING;

DELETE FROM prompt_label_quarantine AS q
USING prompts AS p, prompt_versions AS v
WHERE q.reason = 'invalid_label_format'
    AND q.original_label ~ '^[a-z][a-z0-9_-]{0,63}$'
    AND q.original_label <> 'latest'
    AND p.id = q.original_prompt_id
    AND p.project_id = q.original_project_id
    AND v.id = q.original_version_id
    AND v.prompt_id = q.original_prompt_id;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_labels'::regclass
            AND conname = 'prompt_labels_label_format_check'
    ) THEN
        ALTER TABLE prompt_labels
            ADD CONSTRAINT prompt_labels_label_format_check
            CHECK (label ~ '^[a-z][a-z0-9_-]{0,63}$');
    END IF;
END
$$;
