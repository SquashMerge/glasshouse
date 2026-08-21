DO $$
DECLARE
    fixture_project_id UUID := '70000000-0000-4000-8000-000000000001';
    fixture_dataset_id UUID := '70000000-0000-4000-8000-000000000002';
    fixture_draft_id UUID := '70000000-0000-4000-8000-000000000003';
    fixture_published_item_id UUID := '70000000-0000-4000-8000-000000000006';
    fixture_revision_id UUID := '70000000-0000-4000-8000-000000000007';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM dataset_draft_item_revisions
        WHERE id = fixture_revision_id
          AND project_id = fixture_project_id
          AND dataset_id = fixture_dataset_id
    ) THEN
        RAISE EXCEPTION '0070 did not backfill the revision dataset identity';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_draft_item_revisions'::regclass
          AND conname = 'dataset_draft_item_revisions_project_id_draft_item_id_fkey'
    ) THEN
        RAISE EXCEPTION '0070 retained the disposable draft-item foreign key';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_draft_item_revisions'::regclass
          AND conname = 'dataset_draft_item_revisions_project_dataset_fkey'
          AND confdeltype = 'c'
    ) THEN
        RAISE EXCEPTION '0070 did not retain revisions under the Dataset lifecycle';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_draft_item_revisions'::regclass
          AND conname = 'dataset_draft_item_revisions_published_item_fkey'
          AND confdeltype = 'n'
          AND pg_get_constraintdef(oid) LIKE '%ON DELETE SET NULL (dataset_version_item_id)%'
    ) THEN
        RAISE EXCEPTION '0070 did not preserve the optional published-item identity';
    END IF;

    IF to_regclass('dataset_draft_item_revisions_dataset_history_idx') IS NULL
       OR to_regclass('dataset_draft_item_revisions_published_history_idx') IS NULL THEN
        RAISE EXCEPTION '0070 revision history indexes are missing';
    END IF;

    UPDATE dataset_draft_item_revisions
    SET dataset_version_item_id = fixture_published_item_id
    WHERE id = fixture_revision_id;

    DELETE FROM dataset_drafts
    WHERE id = fixture_draft_id;

    IF NOT EXISTS (
        SELECT 1
        FROM dataset_draft_item_revisions
        WHERE id = fixture_revision_id
          AND dataset_id = fixture_dataset_id
          AND dataset_version_item_id = fixture_published_item_id
    ) THEN
        RAISE EXCEPTION '0070 discarded draft deletion removed its revision history';
    END IF;

    BEGIN
        UPDATE dataset_draft_item_revisions
        SET dataset_id = NULL
        WHERE id = fixture_revision_id;
        RAISE EXCEPTION '0070 accepted a revision without dataset scope';
    EXCEPTION WHEN not_null_violation THEN
        NULL;
    END;
END
$$;
