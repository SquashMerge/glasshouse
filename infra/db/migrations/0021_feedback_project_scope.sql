-- Enforce that feedback workflow links cannot cross project or dataset boundaries.
DO $$
DECLARE
    violations TEXT;
BEGIN
    SELECT string_agg(detail, E'\n' ORDER BY detail)
    INTO violations
    FROM (
        SELECT format(
            'feedback review score/project mismatch: score_id=%s review_project_id=%s score_project_id=%s',
            r.score_id,
            r.project_id,
            s.project_id
        ) AS detail
        FROM feedback_reviews r
        JOIN scores s ON s.id = r.score_id
        WHERE r.project_id <> s.project_id

        UNION ALL

        SELECT format(
            'feedback review dataset/project mismatch: score_id=%s review_project_id=%s dataset_id=%s dataset_project_id=%s',
            r.score_id,
            r.project_id,
            d.id,
            d.project_id
        )
        FROM feedback_reviews r
        JOIN datasets d ON d.id = r.dataset_id
        WHERE r.dataset_id IS NOT NULL
          AND r.project_id <> d.project_id

        UNION ALL

        SELECT format(
            'feedback review item/dataset mismatch: score_id=%s dataset_id=%s dataset_item_id=%s item_dataset_id=%s',
            r.score_id,
            r.dataset_id,
            i.id,
            i.dataset_id
        )
        FROM feedback_reviews r
        JOIN dataset_items i ON i.id = r.dataset_item_id
        WHERE r.dataset_item_id IS NOT NULL
          AND r.dataset_id IS DISTINCT FROM i.dataset_id
    ) AS invalid_links;

    IF violations IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot enforce feedback link scope constraints:%', E'\n' || violations;
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS scores_id_project_id_key
    ON scores (id, project_id);
CREATE UNIQUE INDEX IF NOT EXISTS dataset_items_id_dataset_id_key
    ON dataset_items (id, dataset_id);

ALTER TABLE feedback_reviews
    ADD CONSTRAINT feedback_reviews_score_project_fk
        FOREIGN KEY (score_id, project_id)
        REFERENCES scores (id, project_id)
        ON DELETE CASCADE,
    ADD CONSTRAINT feedback_reviews_dataset_project_fk
        FOREIGN KEY (dataset_id, project_id)
        REFERENCES datasets (id, project_id)
        ON DELETE RESTRICT,
    ADD CONSTRAINT feedback_reviews_dataset_item_dataset_fk
        FOREIGN KEY (dataset_item_id, dataset_id)
        REFERENCES dataset_items (id, dataset_id)
        ON DELETE RESTRICT;
