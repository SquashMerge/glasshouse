-- P3.4: persist the evaluator fingerprint alongside the immutable run
-- contract so evidence comparisons never infer evaluator identity from a
-- mutable definition or unordered application object.
ALTER TABLE evaluation_run_inputs
    ADD COLUMN IF NOT EXISTS evaluator_fingerprint TEXT;

UPDATE evaluation_run_inputs
SET evaluator_fingerprint = encode(digest(evaluator::text, 'sha256'), 'hex')
WHERE evaluator_fingerprint IS NULL;

ALTER TABLE evaluation_run_inputs
    ALTER COLUMN evaluator_fingerprint SET NOT NULL;
ALTER TABLE evaluation_run_inputs
    DROP CONSTRAINT IF EXISTS evaluation_run_inputs_evaluator_fingerprint_check;
ALTER TABLE evaluation_run_inputs
    ADD CONSTRAINT evaluation_run_inputs_evaluator_fingerprint_check
    CHECK (evaluator_fingerprint ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS evaluation_run_inputs_evaluator_fingerprint_idx
    ON evaluation_run_inputs (project_id, evaluator_fingerprint);
