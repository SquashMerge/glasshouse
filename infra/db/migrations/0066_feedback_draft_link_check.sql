-- Superseded by feedback_reviews_added_dataset_link_check, which permits a
-- review to retain either an immutable snapshot or its revisioned draft item.
ALTER TABLE feedback_reviews DROP CONSTRAINT IF EXISTS feedback_reviews_check;
