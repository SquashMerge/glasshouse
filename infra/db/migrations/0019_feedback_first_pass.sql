-- Immutable human feedback signals with separately mutable review workflow state.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS observation_id TEXT;

CREATE TABLE IF NOT EXISTS feedback_reviews (
    score_id UUID PRIMARY KEY REFERENCES scores(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('new', 'reviewed', 'dismissed', 'added_to_dataset')),
    note TEXT,
    dataset_id UUID REFERENCES datasets(id) ON DELETE RESTRICT,
    dataset_item_id UUID REFERENCES dataset_items(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((dataset_id IS NULL) = (dataset_item_id IS NULL))
);

CREATE TABLE IF NOT EXISTS feedback_idempotency (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    score_id UUID NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, idempotency_key),
    CHECK (idempotency_key ~ '^[ -~]{1,200}$')
);

CREATE INDEX IF NOT EXISTS idx_scores_feedback_target ON scores(project_id, trace_id, observation_id)
    WHERE name = 'human.feedback';
CREATE INDEX IF NOT EXISTS idx_feedback_reviews_project_status ON feedback_reviews(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_reviews_dataset_item ON feedback_reviews(dataset_id, dataset_item_id)
    WHERE dataset_id IS NOT NULL;

-- Feedback signals are append-only once issued; review workflow state lives elsewhere.
CREATE OR REPLACE FUNCTION prevent_human_feedback_score_mutation() RETURNS trigger AS $$
BEGIN
    IF OLD.name = 'human.feedback' THEN
        RAISE EXCEPTION 'human.feedback scores are immutable';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scores_human_feedback_immutable ON scores;
CREATE TRIGGER scores_human_feedback_immutable
    BEFORE UPDATE OR DELETE ON scores
    FOR EACH ROW EXECUTE FUNCTION prevent_human_feedback_score_mutation();
