-- Versioned, reviewable Dataset draft curation with content-safe provenance.
-- Preserve legacy scalar/array payloads inside objects before curation readers
-- require object-shaped JSON. Expected output is optional, but retaining its
-- legacy value keeps historical snapshots inspectable.
UPDATE dataset_draft_items
SET input = jsonb_build_object('legacy_input', input)
WHERE jsonb_typeof(input) IS DISTINCT FROM 'object';

UPDATE dataset_draft_items
SET expected_output = jsonb_build_object('legacy_expected_output', expected_output)
WHERE expected_output IS NOT NULL
  AND jsonb_typeof(expected_output) IS DISTINCT FROM 'object';

DO $$
DECLARE immutable_trigger_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'dataset_version_items'::regclass
          AND tgname = 'dataset_version_items_immutable'
    ) INTO immutable_trigger_exists;
    IF immutable_trigger_exists THEN
        EXECUTE 'ALTER TABLE dataset_version_items DISABLE TRIGGER dataset_version_items_immutable';
    END IF;

    UPDATE dataset_version_items
    SET input = jsonb_build_object('legacy_input', input)
    WHERE jsonb_typeof(input) IS DISTINCT FROM 'object';

    UPDATE dataset_version_items
    SET expected_output = jsonb_build_object('legacy_expected_output', expected_output)
    WHERE expected_output IS NOT NULL
      AND jsonb_typeof(expected_output) IS DISTINCT FROM 'object';

    IF immutable_trigger_exists THEN
        EXECUTE 'ALTER TABLE dataset_version_items ENABLE TRIGGER dataset_version_items_immutable';
    END IF;
END
$$;

ALTER TABLE dataset_draft_items
    ADD COLUMN IF NOT EXISTS validation_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'reviewed',
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS capture_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS created_by UUID,
    ADD COLUMN IF NOT EXISTS updated_by UUID,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

UPDATE dataset_draft_items AS item
SET created_by = draft.created_by,
    updated_by = draft.created_by,
    reviewed_by = draft.created_by,
    reviewed_at = item.updated_at
FROM dataset_drafts AS draft
WHERE draft.id = item.draft_id
  AND draft.project_id = item.project_id
  AND (item.created_by IS NULL OR item.updated_by IS NULL OR item.reviewed_by IS NULL OR item.reviewed_at IS NULL);

ALTER TABLE dataset_draft_items
    ALTER COLUMN created_by SET NOT NULL,
    ALTER COLUMN updated_by SET NOT NULL;

ALTER TABLE dataset_draft_items
    DROP CONSTRAINT IF EXISTS dataset_draft_items_input_check,
    ADD CONSTRAINT dataset_draft_items_input_check
        CHECK (jsonb_typeof(input) = 'object'),
    DROP CONSTRAINT IF EXISTS dataset_draft_items_state_check,
    ADD CONSTRAINT dataset_draft_items_state_check
        CHECK (state IN ('draft', 'reviewed')),
    DROP CONSTRAINT IF EXISTS dataset_draft_items_validation_version_check,
    ADD CONSTRAINT dataset_draft_items_validation_version_check
        CHECK (validation_version > 0),
    DROP CONSTRAINT IF EXISTS dataset_draft_items_capture_context_check,
    ADD CONSTRAINT dataset_draft_items_capture_context_check
        CHECK (jsonb_typeof(capture_context) = 'object'),
    DROP CONSTRAINT IF EXISTS dataset_draft_items_external_id_check,
    ADD CONSTRAINT dataset_draft_items_external_id_check
        CHECK (external_id IS NULL OR (length(btrim(external_id)) BETWEEN 1 AND 200));

ALTER TABLE dataset_draft_items
    DROP CONSTRAINT IF EXISTS dataset_draft_items_expected_output_object_check;
ALTER TABLE dataset_draft_items
    ADD CONSTRAINT dataset_draft_items_expected_output_object_check
        CHECK (expected_output IS NULL OR jsonb_typeof(expected_output) = 'object');

ALTER TABLE dataset_version_items
    ADD COLUMN IF NOT EXISTS validation_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'reviewed',
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS feedback_score_id UUID,
    ADD COLUMN IF NOT EXISTS capture_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS curated_by UUID,
    ADD COLUMN IF NOT EXISTS reviewed_by UUID,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE dataset_version_items
    DROP CONSTRAINT IF EXISTS dataset_version_items_input_check,
    ADD CONSTRAINT dataset_version_items_input_check
        CHECK (jsonb_typeof(input) = 'object'),
    DROP CONSTRAINT IF EXISTS dataset_version_items_state_check,
    ADD CONSTRAINT dataset_version_items_state_check
        CHECK (state IN ('draft', 'reviewed')),
    DROP CONSTRAINT IF EXISTS dataset_version_items_validation_version_check,
    ADD CONSTRAINT dataset_version_items_validation_version_check
        CHECK (validation_version > 0),
    DROP CONSTRAINT IF EXISTS dataset_version_items_capture_context_check,
    ADD CONSTRAINT dataset_version_items_capture_context_check
        CHECK (jsonb_typeof(capture_context) = 'object'),
    DROP CONSTRAINT IF EXISTS dataset_version_items_external_id_check,
    ADD CONSTRAINT dataset_version_items_external_id_check
        CHECK (external_id IS NULL OR (length(btrim(external_id)) BETWEEN 1 AND 200));

ALTER TABLE dataset_version_items
    DROP CONSTRAINT IF EXISTS dataset_version_items_expected_output_object_check;
ALTER TABLE dataset_version_items
    ADD CONSTRAINT dataset_version_items_expected_output_object_check
        CHECK (expected_output IS NULL OR jsonb_typeof(expected_output) = 'object');

CREATE TABLE IF NOT EXISTS dataset_draft_item_revisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    draft_item_id UUID NOT NULL,
    item_revision INTEGER NOT NULL CHECK (item_revision > 0),
    item_key TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    validation_version INTEGER NOT NULL CHECK (validation_version > 0),
    state TEXT NOT NULL CHECK (state IN ('draft', 'reviewed')),
    input JSONB NOT NULL CHECK (jsonb_typeof(input) = 'object'),
    expected_output JSONB CHECK (expected_output IS NULL OR jsonb_typeof(expected_output) = 'object'),
    metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
    external_id TEXT,
    source_trace_id TEXT,
    source_observation_id TEXT,
    feedback_score_id UUID,
    capture_context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capture_context) = 'object'),
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK (action IN ('upserted', 'captured', 'imported', 'reviewed', 'reordered')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (draft_item_id, item_revision),
    FOREIGN KEY (project_id, draft_item_id)
        REFERENCES dataset_draft_items(project_id, id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS dataset_draft_item_revisions_item_revision_idx
    ON dataset_draft_item_revisions(draft_item_id, item_revision DESC);

CREATE TABLE IF NOT EXISTS dataset_curation_idempotency (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actor_id UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    operation TEXT NOT NULL CHECK (operation IN ('import', 'capture', 'feedback_promotion')),
    idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[ -~]{1,200}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, actor_id, operation, idempotency_key)
);

ALTER TABLE dataset_lifecycle_audit_events
    DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_event_type_check;
ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_event_type_check CHECK (event_type IN (
        'created', 'metadata_updated', 'archived', 'restored',
        'draft_created', 'draft_discarded', 'draft_item_upserted',
        'draft_item_deleted', 'draft_published', 'draft_item_captured',
        'draft_item_reviewed', 'draft_items_imported', 'draft_items_reordered'
    ));
