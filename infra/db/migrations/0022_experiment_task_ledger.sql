-- Durable per-item work ledger. A lease prevents two API replicas from owning a task at once.
CREATE TABLE IF NOT EXISTS experiment_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    dataset_item_id UUID NOT NULL REFERENCES dataset_items(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (experiment_id, dataset_item_id),
    CHECK (
        (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS experiment_tasks_claimable_idx
    ON experiment_tasks (experiment_id, status, lease_expires_at, created_at);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM experiment_results
        GROUP BY experiment_id, dataset_item_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'cannot add durable experiment result uniqueness: duplicate experiment_results exist';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass
            AND conname = 'experiment_results_experiment_dataset_item_key'
    ) THEN
        ALTER TABLE experiment_results
            ADD CONSTRAINT experiment_results_experiment_dataset_item_key
            UNIQUE (experiment_id, dataset_item_id);
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION seed_experiment_tasks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO experiment_tasks (experiment_id, dataset_item_id)
    SELECT NEW.id, item.id
    FROM dataset_items item
    WHERE item.dataset_id = NEW.dataset_id
    ON CONFLICT (experiment_id, dataset_item_id) DO NOTHING;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS experiments_seed_tasks ON experiments;
CREATE TRIGGER experiments_seed_tasks
AFTER INSERT ON experiments
FOR EACH ROW EXECUTE FUNCTION seed_experiment_tasks();

-- Existing evaluations receive the same immutable item ledger as new evaluations.
INSERT INTO experiment_tasks (experiment_id, dataset_item_id)
SELECT experiment.id, item.id
FROM experiments experiment
JOIN dataset_items item ON item.dataset_id = experiment.dataset_id
ON CONFLICT (experiment_id, dataset_item_id) DO NOTHING;
