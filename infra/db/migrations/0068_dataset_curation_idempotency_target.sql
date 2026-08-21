-- Persist the Dataset target so retained curation retries remain target-scoped.
ALTER TABLE dataset_curation_idempotency
    ADD COLUMN IF NOT EXISTS dataset_id UUID;

UPDATE dataset_curation_idempotency AS idempotency
SET dataset_id = draft.dataset_id
FROM dataset_drafts AS draft
WHERE idempotency.dataset_id IS NULL
  AND draft.project_id = idempotency.project_id
  AND draft.id::text = idempotency.response ->> 'draft_id';

CREATE INDEX IF NOT EXISTS dataset_curation_idempotency_project_dataset_idx
    ON dataset_curation_idempotency(project_id, dataset_id);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_curation_idempotency'::regclass
          AND conname = 'dataset_curation_idempotency_dataset_scope_fkey'
    ) THEN
        ALTER TABLE dataset_curation_idempotency
            ADD CONSTRAINT dataset_curation_idempotency_dataset_scope_fkey
            FOREIGN KEY (project_id, dataset_id)
            REFERENCES datasets(project_id, id)
            ON DELETE SET NULL (dataset_id);
    END IF;
END $$;
