-- Retain curation history independently of the disposable draft workspace.
-- Final Dataset deletion remains the content-retention boundary.
ALTER TABLE dataset_draft_item_revisions
    ADD COLUMN IF NOT EXISTS dataset_id UUID,
    ADD COLUMN IF NOT EXISTS dataset_version_item_id UUID;

UPDATE dataset_draft_item_revisions AS revision
SET dataset_id = draft.dataset_id
FROM dataset_draft_items AS item
JOIN dataset_drafts AS draft
  ON draft.id = item.draft_id
 AND draft.project_id = item.project_id
WHERE revision.dataset_id IS NULL
  AND item.id = revision.draft_item_id
  AND item.project_id = revision.project_id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dataset_draft_item_revisions
        WHERE dataset_id IS NULL
    ) THEN
        RAISE EXCEPTION 'dataset draft item revisions missing durable dataset identity';
    END IF;
END
$$;

ALTER TABLE dataset_draft_item_revisions
    ALTER COLUMN dataset_id SET NOT NULL,
    DROP CONSTRAINT IF EXISTS dataset_draft_item_revisions_project_id_draft_item_id_fkey;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_draft_item_revisions'::regclass
          AND conname = 'dataset_draft_item_revisions_project_dataset_fkey'
    ) THEN
        ALTER TABLE dataset_draft_item_revisions
            ADD CONSTRAINT dataset_draft_item_revisions_project_dataset_fkey
            FOREIGN KEY (project_id, dataset_id)
            REFERENCES datasets(project_id, id)
            ON DELETE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_draft_item_revisions'::regclass
          AND conname = 'dataset_draft_item_revisions_published_item_fkey'
    ) THEN
        ALTER TABLE dataset_draft_item_revisions
            ADD CONSTRAINT dataset_draft_item_revisions_published_item_fkey
            FOREIGN KEY (project_id, dataset_version_item_id)
            REFERENCES dataset_version_items(project_id, id)
            ON DELETE SET NULL (dataset_version_item_id);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS dataset_draft_item_revisions_dataset_history_idx
    ON dataset_draft_item_revisions (
        project_id,
        dataset_id,
        draft_item_id,
        item_revision DESC
    );

CREATE INDEX IF NOT EXISTS dataset_draft_item_revisions_published_history_idx
    ON dataset_draft_item_revisions (
        project_id,
        dataset_id,
        dataset_version_item_id,
        item_revision DESC
    )
    WHERE dataset_version_item_id IS NOT NULL;
