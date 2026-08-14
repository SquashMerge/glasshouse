-- Project-scoped item keys do not establish which dataset owns a snapshot or draft.
-- Keep feedback links tied to the dataset identity selected by the review.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM feedback_reviews AS review
        LEFT JOIN dataset_version_items AS item
            ON item.id = review.dataset_item_id
            AND item.project_id = review.project_id
        LEFT JOIN dataset_versions AS version
            ON version.id = item.dataset_version_id
            AND version.project_id = review.project_id
        LEFT JOIN dataset_draft_items AS draft_item
            ON draft_item.id = review.dataset_draft_item_id
            AND draft_item.project_id = review.project_id
        LEFT JOIN dataset_drafts AS draft
            ON draft.id = draft_item.draft_id
            AND draft.project_id = review.project_id
        WHERE review.status = 'added_to_dataset'
          AND (
              (review.dataset_item_id IS NOT NULL AND version.dataset_id IS DISTINCT FROM review.dataset_id)
              OR (review.dataset_draft_item_id IS NOT NULL AND draft.dataset_id IS DISTINCT FROM review.dataset_id)
          )
    ) THEN
        RAISE EXCEPTION 'Cannot enforce feedback dataset link identity';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_feedback_dataset_link_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'added_to_dataset' THEN
        RETURN NEW;
    END IF;

    IF NEW.dataset_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM dataset_version_items AS item
        JOIN dataset_versions AS version
            ON version.id = item.dataset_version_id
            AND version.project_id = item.project_id
        WHERE item.id = NEW.dataset_item_id
          AND item.project_id = NEW.project_id
          AND version.dataset_id = NEW.dataset_id
    ) THEN
        RAISE EXCEPTION 'feedback review snapshot does not belong to its dataset'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.dataset_draft_item_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM dataset_draft_items AS item
        JOIN dataset_drafts AS draft
            ON draft.id = item.draft_id
            AND draft.project_id = item.project_id
        WHERE item.id = NEW.dataset_draft_item_id
          AND item.project_id = NEW.project_id
          AND draft.dataset_id = NEW.dataset_id
    ) THEN
        RAISE EXCEPTION 'feedback review draft item does not belong to its dataset'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS feedback_reviews_dataset_link_identity ON feedback_reviews;
CREATE TRIGGER feedback_reviews_dataset_link_identity
    BEFORE INSERT OR UPDATE OF project_id, status, dataset_id, dataset_item_id, dataset_draft_item_id
    ON feedback_reviews
    FOR EACH ROW EXECUTE FUNCTION enforce_feedback_dataset_link_identity();

CREATE OR REPLACE FUNCTION prevent_dataset_draft_identity_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.project_id <> OLD.project_id OR NEW.dataset_id <> OLD.dataset_id THEN
        RAISE EXCEPTION 'dataset draft identity is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS dataset_drafts_identity_immutable ON dataset_drafts;
CREATE TRIGGER dataset_drafts_identity_immutable
    BEFORE UPDATE ON dataset_drafts
    FOR EACH ROW EXECUTE FUNCTION prevent_dataset_draft_identity_mutation();
