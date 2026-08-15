-- Retention may remove snapshots only while it owns an active project-scoped run.
-- Lifecycle evidence stays append-only through retention and is removed only by
-- the existing lock-ordered permanent project deletion transaction.
ALTER TABLE dataset_lifecycle_audit_events
    DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_dataset_project_fkey,
    ADD COLUMN IF NOT EXISTS draft_revision INTEGER,
    ADD COLUMN IF NOT EXISTS item_count INTEGER;

ALTER TABLE dataset_lifecycle_audit_events
    DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_event_type_check;
ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_event_type_check
    CHECK (event_type IN (
        'created', 'metadata_updated', 'archived', 'restored',
        'draft_created', 'draft_discarded', 'draft_item_upserted'
    ));
ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_draft_revision_check
    CHECK (draft_revision IS NULL OR draft_revision > 0);
ALTER TABLE dataset_lifecycle_audit_events
    ADD CONSTRAINT dataset_lifecycle_audit_events_item_count_check
    CHECK (item_count IS NULL OR item_count >= 0);

CREATE OR REPLACE FUNCTION dataset_retention_is_authorized(target_project_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    run_id_text TEXT := current_setting('astraea.dataset_retention_run_id', true);
    owner_token_text TEXT := current_setting('astraea.dataset_retention_owner_token', true);
BEGIN
    IF run_id_text IS NULL OR owner_token_text IS NULL
        OR run_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR owner_token_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN
        RETURN FALSE;
    END IF;
    RETURN EXISTS (
        SELECT 1
        FROM governance_retention_runs
        WHERE id = run_id_text::uuid
          AND project_id = target_project_id
          AND owner_token = owner_token_text::uuid
          AND status = 'running'
          AND lease_expires_at >= now()
    );
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND (
        project_deletion_is_authorized(OLD.project_id)
        OR dataset_retention_is_authorized(OLD.project_id)
    ) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset snapshots are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_lifecycle_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset lifecycle audit events are append-only' USING ERRCODE = '55000';
END
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
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS dataset_lifecycle_audit_provenance ON dataset_lifecycle_audit_events;
CREATE TRIGGER dataset_lifecycle_audit_provenance
BEFORE INSERT ON dataset_lifecycle_audit_events
FOR EACH ROW EXECUTE FUNCTION require_dataset_lifecycle_audit_provenance();
