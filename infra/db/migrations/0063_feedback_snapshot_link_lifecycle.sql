-- Feedback promoted into a draft must retain a valid immutable snapshot link on publish.
CREATE UNIQUE INDEX IF NOT EXISTS dataset_draft_items_project_id_id_key
    ON dataset_draft_items(project_id, id);

ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_dataset_item_dataset_fk;
ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_dataset_item_id_fkey;

-- Legacy links target mutable items. Resolve them to the current immutable snapshot
-- before replacing the foreign key contract.
UPDATE feedback_reviews review
SET dataset_item_id = snapshot.id
FROM dataset_items legacy
JOIN datasets dataset ON dataset.id = legacy.dataset_id
JOIN dataset_versions version
    ON version.project_id = dataset.project_id
    AND version.dataset_id = dataset.id
    AND version.version = dataset.latest_published_version
JOIN dataset_version_items snapshot
    ON snapshot.project_id = version.project_id
    AND snapshot.dataset_version_id = version.id
    AND snapshot.item_key = legacy.id::text
WHERE review.dataset_item_id = legacy.id
    AND review.dataset_id = legacy.dataset_id
    AND review.project_id = dataset.project_id;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM feedback_reviews
        WHERE dataset_item_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM dataset_version_items snapshot
              WHERE snapshot.id = feedback_reviews.dataset_item_id
                AND snapshot.project_id = feedback_reviews.project_id
          )
    ) THEN
        RAISE EXCEPTION 'Cannot migrate feedback item links to immutable snapshots';
    END IF;
END
$$;

ALTER TABLE feedback_reviews
    ADD CONSTRAINT feedback_reviews_dataset_version_item_project_fk
        FOREIGN KEY (dataset_item_id, project_id)
        REFERENCES dataset_version_items(id, project_id)
        ON DELETE RESTRICT;

ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_dataset_draft_item_id_fkey;
ALTER TABLE feedback_reviews
    ADD CONSTRAINT feedback_reviews_dataset_draft_item_project_fk
        FOREIGN KEY (dataset_draft_item_id, project_id)
        REFERENCES dataset_draft_items(id, project_id)
        ON DELETE RESTRICT;
