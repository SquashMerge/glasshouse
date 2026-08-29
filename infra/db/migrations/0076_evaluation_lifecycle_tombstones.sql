-- Evaluation lifecycle preserves immutable definitions and audit provenance.
ALTER TABLE evaluations
    ADD COLUMN IF NOT EXISTS lifecycle_revision INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tombstoned_at TIMESTAMPTZ;

ALTER TABLE evaluations
    DROP CONSTRAINT IF EXISTS evaluations_lifecycle_revision_check,
    ADD CONSTRAINT evaluations_lifecycle_revision_check CHECK (lifecycle_revision > 0),
    DROP CONSTRAINT IF EXISTS evaluations_tombstone_requires_archive,
    ADD CONSTRAINT evaluations_tombstone_requires_archive CHECK (
        tombstoned_at IS NULL OR archived_at IS NOT NULL
    );

ALTER TABLE evaluation_audit_events
    DROP CONSTRAINT IF EXISTS evaluation_audit_events_event_type_check,
    ADD CONSTRAINT evaluation_audit_events_event_type_check CHECK (event_type IN (
        'created', 'draft_updated', 'definition_published', 'archived', 'restored', 'tombstoned'
    ));

CREATE OR REPLACE FUNCTION prevent_unsafe_evaluation_hard_delete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'evaluations are retained as tombstones to preserve definitions and audit evidence'
        USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS evaluations_hard_delete_guard ON evaluations;
CREATE TRIGGER evaluations_hard_delete_guard
BEFORE DELETE ON evaluations
FOR EACH ROW EXECUTE FUNCTION prevent_unsafe_evaluation_hard_delete();
