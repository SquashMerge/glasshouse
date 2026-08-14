DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'feedback_reviews'::regclass
          AND tgname = 'feedback_reviews_dataset_link_identity'
          AND NOT tgisinternal
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'dataset_drafts'::regclass
          AND tgname = 'dataset_drafts_identity_immutable'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'feedback dataset identity triggers are incomplete';
    END IF;

    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_item_id)
        VALUES (
            '65000000-0000-4000-8000-000000000041',
            '11111111-1111-1111-1111-111111111111',
            'added_to_dataset',
            '65000000-0000-4000-8000-000000000001',
            '65000000-0000-4000-8000-000000000022'
        );
        RAISE EXCEPTION 'same-project cross-dataset feedback snapshot link was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_draft_item_id)
        VALUES (
            '65000000-0000-4000-8000-000000000042',
            '11111111-1111-1111-1111-111111111111',
            'added_to_dataset',
            '65000000-0000-4000-8000-000000000001',
            '65000000-0000-4000-8000-000000000032'
        );
        RAISE EXCEPTION 'same-project cross-dataset feedback draft link was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE dataset_drafts
        SET dataset_id = '65000000-0000-4000-8000-000000000001'
        WHERE id = '65000000-0000-4000-8000-000000000031';
        RAISE EXCEPTION 'dataset draft identity mutation was accepted';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;
END;
$$;
