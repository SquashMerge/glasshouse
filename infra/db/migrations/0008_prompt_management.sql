-- Glasshouse Postgres migrations: 0008_prompt_management

ALTER TABLE prompts ADD COLUMN IF NOT EXISTS slug TEXT;

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
        WHERE slug IS NULL
        ORDER BY project_id, id
    LOOP
        base_slug := trim(BOTH '-' FROM regexp_replace(lower(prompt_row.name), '[^a-z0-9]+', '-', 'g'));
        base_slug := COALESCE(NULLIF(base_slug, ''), 'prompt');
        candidate_slug := base_slug;

        IF EXISTS (
            SELECT 1
            FROM prompts
            WHERE project_id = prompt_row.project_id AND slug = candidate_slug
        ) THEN
            id_suffix := substring(replace(prompt_row.id::text, '-', '') FROM 1 FOR 12);
            candidate_slug := left(base_slug, 200) || '-' || id_suffix;
            collision_number := 1;

            WHILE EXISTS (
                SELECT 1
                FROM prompts
                WHERE project_id = prompt_row.project_id AND slug = candidate_slug
            ) LOOP
                candidate_slug := left(base_slug, 190) || '-' || id_suffix || '-' || collision_number::text;
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
CREATE UNIQUE INDEX IF NOT EXISTS prompts_project_id_id_key ON prompts(project_id, id);

ALTER TABLE prompt_versions
    ADD COLUMN IF NOT EXISTS legacy_version INTEGER,
    ADD COLUMN IF NOT EXISTS messages JSONB,
    ADD COLUMN IF NOT EXISTS settings JSONB,
    ADD COLUMN IF NOT EXISTS content_hash TEXT,
    ADD COLUMN IF NOT EXISTS change_message TEXT,
    ADD COLUMN IF NOT EXISTS created_by TEXT;

WITH positive_versions AS (
    SELECT prompt_id, COALESCE(MAX(version) FILTER (WHERE version > 0), 0) AS max_version
    FROM prompt_versions
    GROUP BY prompt_id
), renumbered_versions AS (
    SELECT
        prompt_versions.id,
        prompt_versions.version AS prior_version,
        positive_versions.max_version
            + ROW_NUMBER() OVER (
                PARTITION BY prompt_versions.prompt_id
                ORDER BY prompt_versions.version, prompt_versions.created_at, prompt_versions.id
            ) AS next_version
    FROM prompt_versions
    INNER JOIN positive_versions ON positive_versions.prompt_id = prompt_versions.prompt_id
    WHERE prompt_versions.version <= 0
)
UPDATE prompt_versions
SET legacy_version = renumbered_versions.prior_version,
    version = renumbered_versions.next_version
FROM renumbered_versions
WHERE prompt_versions.id = renumbered_versions.id;

UPDATE prompt_versions
SET messages = jsonb_build_array(jsonb_build_object('role', 'user', 'content', content))
WHERE messages IS NULL;

UPDATE prompt_versions
SET settings = CASE
    WHEN jsonb_typeof(metadata) = 'object' THEN metadata
    ELSE '{}'::jsonb
END
WHERE settings IS NULL;

UPDATE prompt_versions
SET created_by = 'legacy-migration',
    change_message = NULL
WHERE created_by IS NULL OR created_by !~ '[^[:space:]]';

CREATE OR REPLACE FUNCTION prompt_version_content_hash(messages JSONB, model TEXT, settings JSONB)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT encode(
        digest(jsonb_build_object('messages', messages, 'model', model, 'settings', settings)::text, 'sha256'),
        'hex'
    )
$$;

UPDATE prompt_versions
SET content_hash = prompt_version_content_hash(messages, model, settings)
WHERE content_hash IS NULL;

CREATE OR REPLACE FUNCTION prompt_version_messages_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
    SELECT CASE
        WHEN jsonb_typeof(value) <> 'array' THEN false
        ELSE jsonb_array_length(value) BETWEEN 1 AND 2
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(value) AS element(message)
                WHERE jsonb_typeof(message) <> 'object'
                    OR jsonb_typeof(message->'role') <> 'string'
                    OR message->>'role' NOT IN ('system', 'user')
                    OR jsonb_typeof(message->'content') <> 'string'
            )
            AND NOT EXISTS (
                SELECT message->>'role'
                FROM jsonb_array_elements(value) AS element(message)
                GROUP BY message->>'role'
                HAVING count(*) > 1
            )
    END
$$;

ALTER TABLE prompt_versions
    ALTER COLUMN messages SET NOT NULL,
    ALTER COLUMN settings SET NOT NULL,
    ALTER COLUMN content_hash SET NOT NULL,
    ALTER COLUMN created_by SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_versions'::regclass
            AND conname = 'prompt_versions_version_positive_check'
    ) THEN
        ALTER TABLE prompt_versions
            ADD CONSTRAINT prompt_versions_version_positive_check CHECK (version > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_versions'::regclass
            AND conname = 'prompt_versions_messages_check'
    ) THEN
        ALTER TABLE prompt_versions
            ADD CONSTRAINT prompt_versions_messages_check CHECK (prompt_version_messages_valid(messages));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_versions'::regclass
            AND conname = 'prompt_versions_settings_object_check'
    ) THEN
        ALTER TABLE prompt_versions
            ADD CONSTRAINT prompt_versions_settings_object_check CHECK (jsonb_typeof(settings) = 'object');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_versions'::regclass
            AND conname = 'prompt_versions_content_hash_check'
    ) THEN
        ALTER TABLE prompt_versions
            ADD CONSTRAINT prompt_versions_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{64}$');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_versions'::regclass
            AND conname = 'prompt_versions_created_by_check'
    ) THEN
        ALTER TABLE prompt_versions
            ADD CONSTRAINT prompt_versions_created_by_check CHECK (created_by ~ '[^[:space:]]');
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_prompt_id_id_key ON prompt_versions(prompt_id, id);

CREATE TABLE IF NOT EXISTS prompt_label_quarantine (
    original_project_id UUID NOT NULL,
    original_prompt_id UUID NOT NULL,
    original_version_id UUID NOT NULL,
    original_label TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (original_project_id, original_prompt_id, original_version_id, original_label, reason)
);

WITH invalid_bindings AS (
    SELECT
        prompt_labels.ctid AS binding_id,
        prompt_labels.project_id,
        prompt_labels.prompt_id,
        prompt_labels.version_id,
        prompt_labels.label,
        CASE
            WHEN prompt_labels.label !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN 'invalid_label_format'
            WHEN prompt_labels.label = 'latest' THEN 'reserved_latest'
            WHEN prompts.project_id <> prompt_labels.project_id THEN 'prompt_project_mismatch'
            WHEN prompt_versions.prompt_id <> prompt_labels.prompt_id THEN 'version_prompt_mismatch'
        END AS reason
    FROM prompt_labels
    INNER JOIN prompts ON prompts.id = prompt_labels.prompt_id
    INNER JOIN prompt_versions ON prompt_versions.id = prompt_labels.version_id
)
INSERT INTO prompt_label_quarantine (
    original_project_id,
    original_prompt_id,
    original_version_id,
    original_label,
    reason
)
SELECT project_id, prompt_id, version_id, label, reason
FROM invalid_bindings
WHERE reason IS NOT NULL
ON CONFLICT DO NOTHING;

WITH invalid_bindings AS (
    SELECT
        prompt_labels.ctid AS binding_id,
        CASE
            WHEN prompt_labels.label !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN 'invalid_label_format'
            WHEN prompt_labels.label = 'latest' THEN 'reserved_latest'
            WHEN prompts.project_id <> prompt_labels.project_id THEN 'prompt_project_mismatch'
            WHEN prompt_versions.prompt_id <> prompt_labels.prompt_id THEN 'version_prompt_mismatch'
        END AS reason
    FROM prompt_labels
    INNER JOIN prompts ON prompts.id = prompt_labels.prompt_id
    INNER JOIN prompt_versions ON prompt_versions.id = prompt_labels.version_id
)
DELETE FROM prompt_labels
USING invalid_bindings
WHERE prompt_labels.ctid = invalid_bindings.binding_id
    AND invalid_bindings.reason IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_labels'::regclass
            AND conname = 'prompt_labels_label_format_check'
    ) THEN
        ALTER TABLE prompt_labels
            ADD CONSTRAINT prompt_labels_label_format_check
            CHECK (label ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_labels'::regclass
            AND conname = 'prompt_labels_not_latest_check'
    ) THEN
        ALTER TABLE prompt_labels
            ADD CONSTRAINT prompt_labels_not_latest_check CHECK (label <> 'latest');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_labels'::regclass
            AND conname = 'prompt_labels_project_prompt_fkey'
    ) THEN
        ALTER TABLE prompt_labels
            ADD CONSTRAINT prompt_labels_project_prompt_fkey
            FOREIGN KEY (project_id, prompt_id)
            REFERENCES prompts(project_id, id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_labels'::regclass
            AND conname = 'prompt_labels_prompt_version_fkey'
    ) THEN
        ALTER TABLE prompt_labels
            ADD CONSTRAINT prompt_labels_prompt_version_fkey
            FOREIGN KEY (prompt_id, version_id)
            REFERENCES prompt_versions(prompt_id, id)
            ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION set_prompt_version_content_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.content_hash := prompt_version_content_hash(NEW.messages, NEW.model, NEW.settings);
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS prompt_versions_set_content_hash ON prompt_versions;
CREATE TRIGGER prompt_versions_set_content_hash
BEFORE INSERT ON prompt_versions
FOR EACH ROW
EXECUTE FUNCTION set_prompt_version_content_hash();

CREATE OR REPLACE FUNCTION prevent_prompt_version_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'prompt_versions are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS prompt_versions_immutable ON prompt_versions;
CREATE TRIGGER prompt_versions_immutable
BEFORE UPDATE ON prompt_versions
FOR EACH ROW
EXECUTE FUNCTION prevent_prompt_version_update();
