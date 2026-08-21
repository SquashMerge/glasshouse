DO $$
DECLARE
    project_id UUID := '67000000-0000-4000-8000-000000000001';
    draft_id UUID := '67000000-0000-4000-8000-000000000003';
    item_id UUID := '67000000-0000-4000-8000-000000000004';
    actor_id UUID := durable_actor_id('basic:v1', 'bootstrap-owner');
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM dataset_draft_items
        WHERE id = item_id
          AND validation_version = 1
          AND state = 'reviewed'
          AND capture_context = '{}'::jsonb
          AND created_by = actor_id
          AND updated_by = actor_id
          AND reviewed_by = actor_id
          AND reviewed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION '0067 did not safely backfill draft curation fields';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dataset_version_items'
          AND column_name IN ('validation_version', 'state', 'external_id', 'feedback_score_id', 'capture_context', 'curated_by', 'reviewed_by', 'reviewed_at')
        GROUP BY table_name
        HAVING count(*) = 8
    ) THEN
        RAISE EXCEPTION '0067 snapshot curation fields are incomplete';
    END IF;

    BEGIN
        INSERT INTO dataset_draft_items (
            project_id, draft_id, item_key, position, input, expected_output,
            metadata, created_by, updated_by, state
        ) VALUES (
            project_id, draft_id, 'invalid-expected-output', 1,
            '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, actor_id, actor_id, 'draft'
        );
        RAISE EXCEPTION '0067 accepted non-object expected output';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO dataset_draft_item_revisions (
        project_id, draft_item_id, item_revision, item_key, position,
        validation_version, state, input, expected_output, metadata,
        actor_id, action
    ) VALUES (
        project_id, item_id, 1, 'legacy-curation-case', 0,
        1, 'reviewed', '{"question":"safe"}'::jsonb,
        '{"answer":"safe"}'::jsonb, '{"cohort":"fixture"}'::jsonb,
        actor_id, 'reviewed'
    );

    BEGIN
        INSERT INTO dataset_draft_item_revisions (
            project_id, draft_item_id, item_revision, item_key, position,
            validation_version, state, input, metadata, actor_id, action
        ) VALUES (
            project_id, item_id, 1, 'legacy-curation-case', 0,
            1, 'reviewed', '{}'::jsonb, '{}'::jsonb, actor_id, 'reviewed'
        );
        RAISE EXCEPTION '0067 accepted duplicate item revision';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    INSERT INTO dataset_curation_idempotency (
        project_id, actor_id, operation, idempotency_key, request_hash, response
    ) VALUES (
        project_id, actor_id, 'capture', 'fixture-capture-key', repeat('a', 64),
        jsonb_build_object('draft_id', draft_id, 'revision', 1, 'item_ids', jsonb_build_array(item_id))
    );

    BEGIN
        INSERT INTO dataset_curation_idempotency (
            project_id, actor_id, operation, idempotency_key, request_hash, response
        ) VALUES (
            project_id, actor_id, 'capture', 'fixture-capture-key', repeat('b', 64),
            '{}'::jsonb
        );
        RAISE EXCEPTION '0067 accepted duplicate curation idempotency key';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END
$$;
