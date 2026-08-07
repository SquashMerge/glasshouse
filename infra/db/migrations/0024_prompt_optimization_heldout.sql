-- Pin a versioned optimization-local dataset and keep publication evidence separate
-- from the execution lifecycle so held-out review does not change SSE semantics.
ALTER TABLE prompt_optimization_jobs
    ADD COLUMN IF NOT EXISTS dataset JSONB,
    ADD COLUMN IF NOT EXISTS dataset_hash TEXT,
    ADD COLUMN IF NOT EXISTS candidate_content TEXT,
    ADD COLUMN IF NOT EXISTS evidence JSONB,
    ADD COLUMN IF NOT EXISTS promotion_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS promotion_reason TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
    ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

-- Historical jobs have no independent hold-out evidence. Preserve their submitted
-- examples as legacy training data rather than falsely relabeling old scores.
UPDATE prompt_optimization_jobs
SET dataset = jsonb_build_object(
    'version', 0,
    'rubric', 'Legacy optimization dataset; held-out validation was not recorded.',
    'training_examples', CASE
        WHEN jsonb_typeof(examples) = 'array' THEN examples
        ELSE '[]'::jsonb
    END,
    'validation_examples', '[]'::jsonb
)
WHERE dataset IS NULL;

UPDATE prompt_optimization_jobs
SET dataset_hash = encode(digest(dataset::text, 'sha256'), 'hex')
WHERE dataset_hash IS NULL;

UPDATE prompt_optimization_jobs
SET promotion_status = 'legacy',
    promotion_reason = 'held_out_validation_not_recorded'
WHERE result_version IS NOT NULL AND promotion_status = 'pending';

ALTER TABLE prompt_optimization_jobs
    ALTER COLUMN dataset SET NOT NULL,
    ALTER COLUMN dataset_hash SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_dataset_shape_check'
    ) THEN
        ALTER TABLE prompt_optimization_jobs
            ADD CONSTRAINT prompt_optimization_jobs_dataset_shape_check CHECK (
                jsonb_typeof(dataset) = 'object'
                AND dataset->>'version' IN ('0', '1')
                AND jsonb_typeof(dataset->'training_examples') = 'array'
                AND jsonb_typeof(dataset->'validation_examples') = 'array'
                AND jsonb_typeof(dataset->'rubric') = 'string'
                AND dataset_hash ~ '^[0-9a-f]{64}$'
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_promotion_status_check'
    ) THEN
        ALTER TABLE prompt_optimization_jobs
            ADD CONSTRAINT prompt_optimization_jobs_promotion_status_check CHECK (
                promotion_status IN (
                    'pending',
                    'auto_promoted',
                    'review_required',
                    'blocked',
                    'reviewed_promoted',
                    'legacy'
                )
            );
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION prevent_prompt_optimization_dataset_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.dataset IS DISTINCT FROM OLD.dataset
        OR NEW.dataset_hash IS DISTINCT FROM OLD.dataset_hash THEN
        RAISE EXCEPTION 'prompt optimization dataset snapshots are immutable'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS prompt_optimization_dataset_immutable ON prompt_optimization_jobs;
CREATE TRIGGER prompt_optimization_dataset_immutable
BEFORE UPDATE OF dataset, dataset_hash ON prompt_optimization_jobs
FOR EACH ROW EXECUTE FUNCTION prevent_prompt_optimization_dataset_mutation();

CREATE INDEX IF NOT EXISTS prompt_optimization_jobs_review_required_idx
    ON prompt_optimization_jobs(project_id, updated_at DESC)
    WHERE promotion_status = 'review_required';
