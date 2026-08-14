-- Legacy mutable item links must retain the experiment's project ownership.
ALTER TABLE dataset_items ADD COLUMN IF NOT EXISTS project_id UUID;

UPDATE dataset_items AS item
SET project_id = dataset.project_id
FROM datasets AS dataset
WHERE dataset.id = item.dataset_id
  AND item.project_id IS NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM dataset_items AS item
        LEFT JOIN datasets AS dataset ON dataset.id = item.dataset_id
        WHERE dataset.id IS NULL
           OR item.project_id IS NULL
           OR item.project_id <> dataset.project_id
    ) THEN
        RAISE EXCEPTION 'Cannot scope legacy dataset items to their owning project';
    END IF;
END
$$;

ALTER TABLE dataset_items ALTER COLUMN project_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dataset_items_project_id_id_key
    ON dataset_items(project_id, id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_items'::regclass
          AND conname = 'dataset_items_project_dataset_fkey'
    ) THEN
        ALTER TABLE dataset_items
            ADD CONSTRAINT dataset_items_project_dataset_fkey
            FOREIGN KEY (project_id, dataset_id)
            REFERENCES datasets(project_id, id)
            ON DELETE CASCADE;
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS experiment_legacy_item_link_quarantine (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    record_kind TEXT NOT NULL CHECK (record_kind IN ('task', 'result')),
    record_id UUID NOT NULL,
    project_id UUID NOT NULL,
    experiment_id UUID NOT NULL,
    dataset_item_id UUID NOT NULL,
    dataset_item_project_id UUID,
    reason TEXT NOT NULL CHECK (reason = 'dataset_item_project_mismatch'),
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (record_kind, record_id),
    FOREIGN KEY (project_id, experiment_id)
        REFERENCES experiments(project_id, id)
        ON DELETE CASCADE
);

INSERT INTO experiment_legacy_item_link_quarantine (
    record_kind,
    record_id,
    project_id,
    experiment_id,
    dataset_item_id,
    dataset_item_project_id,
    reason
)
SELECT
    'task',
    task.id,
    experiment.project_id,
    task.experiment_id,
    task.dataset_item_id,
    item.project_id,
    'dataset_item_project_mismatch'
FROM experiment_tasks AS task
JOIN experiments AS experiment ON experiment.id = task.experiment_id
LEFT JOIN dataset_items AS item ON item.id = task.dataset_item_id
WHERE task.dataset_item_id IS NOT NULL
  AND (
      task.project_id IS DISTINCT FROM experiment.project_id
      OR item.project_id IS DISTINCT FROM experiment.project_id
  )
ON CONFLICT (record_kind, record_id) DO NOTHING;

INSERT INTO experiment_legacy_item_link_quarantine (
    record_kind,
    record_id,
    project_id,
    experiment_id,
    dataset_item_id,
    dataset_item_project_id,
    reason
)
SELECT
    'result',
    result.id,
    experiment.project_id,
    result.experiment_id,
    result.dataset_item_id,
    item.project_id,
    'dataset_item_project_mismatch'
FROM experiment_results AS result
JOIN experiments AS experiment ON experiment.id = result.experiment_id
LEFT JOIN dataset_items AS item ON item.id = result.dataset_item_id
WHERE result.dataset_item_id IS NOT NULL
  AND (
      result.project_id IS DISTINCT FROM experiment.project_id
      OR item.project_id IS DISTINCT FROM experiment.project_id
  )
ON CONFLICT (record_kind, record_id) DO NOTHING;

UPDATE experiment_tasks
SET status = 'cancelled',
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = now()
WHERE experiment_id IN (
    SELECT experiment_id
    FROM experiment_legacy_item_link_quarantine
    WHERE record_kind = 'task'
)
  AND status IN ('pending', 'running');

UPDATE experiments
SET status = 'cancelled',
    updated_at = now()
WHERE id IN (
    SELECT experiment_id
    FROM experiment_legacy_item_link_quarantine
    WHERE record_kind = 'task'
)
  AND status IN ('pending', 'running');

DELETE FROM experiment_results AS result
USING experiment_legacy_item_link_quarantine AS quarantine
WHERE quarantine.record_kind = 'result'
  AND quarantine.record_id = result.id;

DELETE FROM experiment_tasks AS task
USING experiment_legacy_item_link_quarantine AS quarantine
WHERE quarantine.record_kind = 'task'
  AND quarantine.record_id = task.id;

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_dataset_item_id_fkey,
    DROP CONSTRAINT IF EXISTS experiment_tasks_project_legacy_item_fkey;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_project_legacy_item_fkey
    FOREIGN KEY (project_id, dataset_item_id)
    REFERENCES dataset_items(project_id, id)
    ON DELETE RESTRICT;

ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_dataset_item_id_fkey,
    DROP CONSTRAINT IF EXISTS experiment_results_project_legacy_item_fkey;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_project_legacy_item_fkey
    FOREIGN KEY (project_id, dataset_item_id)
    REFERENCES dataset_items(project_id, id)
    ON DELETE RESTRICT;
