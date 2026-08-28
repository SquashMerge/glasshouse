-- P2.4 keeps dataset lifecycle actions revisioned, auditable, and evidence-safe.
ALTER TABLE datasets
    ADD COLUMN IF NOT EXISTS lifecycle_revision INTEGER NOT NULL DEFAULT 1;

ALTER TABLE datasets
    DROP CONSTRAINT IF EXISTS datasets_lifecycle_revision_check,
    ADD CONSTRAINT datasets_lifecycle_revision_check CHECK (lifecycle_revision > 0);

CREATE TABLE IF NOT EXISTS dataset_retention_holds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    dataset_id UUID NOT NULL,
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
    created_by UUID NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_by UUID REFERENCES actors(id) ON DELETE RESTRICT,
    released_at TIMESTAMPTZ,
    FOREIGN KEY (organization_id, project_id)
        REFERENCES projects(organization_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, dataset_id)
        REFERENCES datasets(project_id, id) ON DELETE RESTRICT,
    CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX IF NOT EXISTS dataset_retention_holds_active_dataset_idx
    ON dataset_retention_holds(project_id, dataset_id)
    WHERE released_at IS NULL;

ALTER TABLE dataset_lifecycle_audit_events
    DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_event_type_check,
    ADD CONSTRAINT dataset_lifecycle_audit_events_event_type_check CHECK (event_type IN (
        'created', 'metadata_updated', 'archived', 'restored', 'tombstoned', 'exported',
        'draft_created', 'draft_discarded', 'draft_item_upserted',
        'draft_item_deleted', 'draft_published', 'draft_item_captured',
        'draft_item_reviewed', 'draft_items_imported', 'draft_items_reordered'
    ));

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
        CASE
            WHEN NEW.event_type IN ('archived', 'restored', 'tombstoned', 'exported')
                THEN 'destructive'
            ELSE 'curation_write'
        END
    ) THEN
        RAISE EXCEPTION 'dataset lifecycle audit actor is not authorized' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION prevent_unsafe_dataset_hard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;

    IF EXISTS (SELECT 1 FROM dataset_versions WHERE dataset_id = OLD.id)
       OR EXISTS (SELECT 1 FROM experiments WHERE dataset_id = OLD.id)
       OR EXISTS (SELECT 1 FROM benchmark_suites WHERE dataset_id = OLD.id)
       OR EXISTS (SELECT 1 FROM feedback_reviews WHERE dataset_id = OLD.id)
       OR EXISTS (
            SELECT 1
            FROM dataset_retention_holds
            WHERE project_id = OLD.project_id
              AND dataset_id = OLD.id
              AND released_at IS NULL
       ) THEN
        RAISE EXCEPTION 'dataset has retained immutable or historical dependencies'
            USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
END
$$;

CREATE OR REPLACE FUNCTION prevent_dataset_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'dataset snapshots are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS datasets_hard_delete_guard ON datasets;
CREATE TRIGGER datasets_hard_delete_guard
BEFORE DELETE ON datasets
FOR EACH ROW EXECUTE FUNCTION prevent_unsafe_dataset_hard_delete();
