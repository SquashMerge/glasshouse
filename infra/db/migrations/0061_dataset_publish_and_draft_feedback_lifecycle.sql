-- Publishing consumes a mutable draft while preserving immutable snapshots.
ALTER TABLE dataset_lifecycle_audit_events DROP CONSTRAINT IF EXISTS dataset_lifecycle_audit_events_event_type_check;
ALTER TABLE dataset_lifecycle_audit_events ADD CONSTRAINT dataset_lifecycle_audit_events_event_type_check CHECK (event_type IN ('created', 'metadata_updated', 'archived', 'restored', 'draft_created', 'draft_discarded', 'draft_item_upserted', 'draft_item_deleted', 'draft_published'));

ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_dataset_draft_item_id_fkey;
ALTER TABLE feedback_reviews ADD CONSTRAINT feedback_reviews_dataset_draft_item_id_fkey FOREIGN KEY (dataset_draft_item_id) REFERENCES dataset_draft_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS dataset_versions_project_dataset_version_idx ON dataset_versions(project_id, dataset_id, version);
CREATE INDEX IF NOT EXISTS dataset_draft_items_draft_position_idx ON dataset_draft_items(draft_id, position);
