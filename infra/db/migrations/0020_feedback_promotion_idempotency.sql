-- A feedback review may promote at most one explicitly chosen dataset case.
ALTER TABLE dataset_items
    ADD COLUMN IF NOT EXISTS feedback_score_id UUID
        REFERENCES scores(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS dataset_items_feedback_score_id_unique
    ON dataset_items(feedback_score_id)
    WHERE feedback_score_id IS NOT NULL;
