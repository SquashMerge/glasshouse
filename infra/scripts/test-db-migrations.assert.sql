DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'scores' AND column_name = 'observation_id'
	) OR NOT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'feedback_reviews'
	) OR NOT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = 'feedback_idempotency'
	) THEN
		RAISE EXCEPTION 'feedback first-pass persistence is incomplete';
	END IF;
    IF (SELECT count(*) FROM projects WHERE slug = 'default') <> 1
        OR (SELECT name FROM projects WHERE slug = 'default') <> 'Default Project' THEN
        RAISE EXCEPTION 'default project was not seeded';
    END IF;

    IF (SELECT slug FROM prompts WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001') <> 'first-prompt' THEN
        RAISE EXCEPTION 'first prompt slug was not normalized';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'bbbbbbbb-0000-0000-0000-000000000001') <> 'greeting' THEN
        RAISE EXCEPTION 'first colliding slug was not retained';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'cccccccc-0000-0000-0000-000000000001') <> 'greeting-cccccccc0000' THEN
        RAISE EXCEPTION 'colliding slug did not use its deterministic UUID suffix';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'dddddddd-0000-0000-0000-000000000001') <> 'prompt' THEN
        RAISE EXCEPTION 'empty slug base did not use prompt fallback';
    END IF;
    IF (SELECT slug FROM prompts WHERE id = 'eeeeeeee-0000-0000-0000-000000000001') <> repeat('a', 63) THEN
        RAISE EXCEPTION 'slug truncation left a boundary separator';
    END IF;
    IF EXISTS (SELECT 1 FROM prompts WHERE slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(slug) > 64) THEN
        RAISE EXCEPTION 'a migrated slug is not canonical';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version IS NULL
            AND content = 'Hello {{name}}'
            AND messages = '[{"role":"user","content":"Hello {{name}}"}]'::jsonb
            AND settings = '{"temperature":0.1}'::jsonb
            AND created_by = 'legacy-migration'
            AND change_message = 'Initial version'
            AND content_hash = '314fa73f1223d7018285b2f15bf43e523dc398ec090792de9e2b7fa8f79bdee5'
    ) THEN
        RAISE EXCEPTION 'positive legacy version was not preserved with its exact migration values';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'aaaaaaaa-0000-0000-0000-000000000102'
            AND version = 2
            AND legacy_version = 0
            AND messages = '[{"role":"user","content":"Legacy zero"}]'::jsonb
            AND settings = '{}'::jsonb
            AND content_hash = 'e4da7ccb5ecb9f8bb2ddac243bb4c31f6a33a2651e0d4573250701c450fcddf4'
    ) THEN
        RAISE EXCEPTION 'non-positive version was not deterministically renumbered';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'cccccccc-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version = -2
            AND content = 'Malformed {{template'
            AND messages = '[{"role":"user","content":"Malformed {{template"}]'::jsonb
            AND settings = '{}'::jsonb
            AND content_hash = '5174f14b782243ec90ce50ff3b5833cf8824d3107c09ff81d6e0b01b62b49bc1'
    ) THEN
        RAISE EXCEPTION 'malformed legacy template was not preserved read-only';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE id = 'dddddddd-0000-0000-0000-000000000101'
            AND version = 1
            AND legacy_version = 0
    ) THEN
        RAISE EXCEPTION 'zero-only prompt version was not renumbered';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE content_hash <> prompt_version_content_hash(messages, model, settings)
    ) THEN
        RAISE EXCEPTION 'a migrated prompt version has a non-canonical content hash';
    END IF;

    IF (SELECT count(*) FROM prompt_label_quarantine) <> 4 THEN
        RAISE EXCEPTION 'obsolete label grammar quarantine rows were not restored';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'invalid!' AND reason = 'invalid_label_format')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'latest' AND reason = 'reserved_latest')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'tenant' AND reason = 'prompt_project_mismatch')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'version-link' AND reason = 'version_prompt_mismatch') THEN
        RAISE EXCEPTION 'label quarantine reason precedence is incorrect';
    END IF;
    IF (SELECT count(*) FROM prompt_labels) <> 2
        OR NOT EXISTS (SELECT 1 FROM prompt_labels WHERE label = 'production')
        OR NOT EXISTS (SELECT 1 FROM prompt_labels WHERE label = 'team_alpha') THEN
        RAISE EXCEPTION 'valid labels were not retained and restored exactly';
    END IF;

    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant-link', 'aaaaaaaa-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'project ownership foreign key did not reject mismatch';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'version-link', 'bbbbbbbb-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'version ownership foreign key did not reject mismatch';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'latest', 'aaaaaaaa-0000-0000-0000-000000000101');
        RAISE EXCEPTION 'latest label constraint did not reject mutation';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_labels (project_id, prompt_id, label, version_id) VALUES
            ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'valid_label', 'aaaaaaaa-0000-0000-0000-000000000101');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'new label grammar rejected underscore label';
    END;

    INSERT INTO prompt_versions (
        prompt_id,
        version,
        content,
        model,
        metadata,
        messages,
        settings,
        content_hash,
        created_by
    ) VALUES (
        'aaaaaaaa-0000-0000-0000-000000000001',
        3,
        'New',
        'new-model',
        '{}',
        '[{"role":"user","content":"New"}]',
        '{"temperature":1}',
        'not-a-hash',
        'migration-test'
    );
    IF NOT EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version = 3
            AND content_hash = 'd94a92f352fb85ecf3a80de8c0ae3caad24fb8a30fb9eda9480f8ec3b3bf7e53'
            AND content_hash = prompt_version_content_hash(messages, model, settings)
    ) THEN
        RAISE EXCEPTION 'insert trigger did not store the authoritative content hash';
    END IF;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id,
            version,
            content,
            metadata,
            messages,
            settings,
            content_hash,
            created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            4,
            'Invalid author',
            '{}',
            '[{"role":"user","content":"Invalid author"}]',
            '{}',
            'not-a-hash',
            E'\t'
        );
        RAISE EXCEPTION 'blank prompt version author was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO prompt_tombstones (project_id, slug)
    VALUES ('11111111-1111-1111-1111-111111111111', 'reserved-prompt');
    BEGIN
        UPDATE prompt_tombstones SET slug = 'changed-prompt';
        RAISE EXCEPTION 'prompt tombstone accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        DELETE FROM prompt_tombstones WHERE project_id = '11111111-1111-1111-1111-111111111111' AND slug = 'reserved-prompt';
        RAISE EXCEPTION 'prompt tombstone accepted a delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    INSERT INTO prompt_tombstones (project_id, slug)
    VALUES ('22222222-2222-2222-2222-222222222222', 'project-reservation');
    BEGIN
        DELETE FROM projects WHERE id = '22222222-2222-2222-2222-222222222222';
        RAISE EXCEPTION 'project deletion removed a prompt tombstone';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        UPDATE prompt_versions
        SET content = 'Changed'
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND version = 3;
        RAISE EXCEPTION 'immutable prompt version accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    IF (
        SELECT messages->0->>'role'
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        ORDER BY version DESC
        LIMIT 1
    ) <> 'user' THEN
        RAISE EXCEPTION 'prompt role was not preserved in canonical messages';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM prompt_versions
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001'
            AND version <= 2
            AND (
                content <> messages->0->>'content'
                OR metadata <> settings
                OR change_message IS NULL
            )
    ) THEN
        RAISE EXCEPTION 'canonical version compatibility mirrors or summaries were not repaired';
    END IF;
    IF (
        SELECT array_agg(column_name::text ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prompt_deletion_audit'
    ) <> ARRAY['project_id', 'prompt_id', 'slug', 'deleted_by', 'deleted_at', 'deleted_version_count'] THEN
        RAISE EXCEPTION 'prompt deletion audit fields are not content-free and exact';
    END IF;
    INSERT INTO prompt_deletion_audit (project_id, prompt_id, slug, deleted_by, deleted_version_count)
    VALUES (
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'first-prompt',
        'migration-test',
        2
    );
    BEGIN
        UPDATE prompt_deletion_audit SET slug = 'changed';
        RAISE EXCEPTION 'prompt deletion audit accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        DELETE FROM prompt_deletion_audit;
        RAISE EXCEPTION 'prompt deletion audit accepted a delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id, version, content, metadata, messages, settings, content_hash, created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            6,
            'Missing role',
            '{}',
            '[{"content":"Missing role"}]',
            '{}',
            'not-a-hash',
            'migration-test'
        );
        RAISE EXCEPTION 'prompt version check accepted a missing role';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO prompt_versions (
            prompt_id, version, content, metadata, messages, settings, content_hash, created_by
        ) VALUES (
            'aaaaaaaa-0000-0000-0000-000000000001',
            7,
            'Missing content',
            '{}',
            '[{"role":"user"}]',
            '{}',
            'not-a-hash',
            'migration-test'
        );
        RAISE EXCEPTION 'prompt version check accepted missing content';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name = 'worker_lease_expires_at'
            AND data_type = 'timestamp with time zone'
    ) THEN
        RAISE EXCEPTION 'prompt optimization worker lease column was not created';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
            AND indexname = 'prompt_optimization_jobs_reclaimable_lease_idx'
    ) THEN
        RAISE EXCEPTION 'prompt optimization worker lease index was not created';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name IN (
                'dataset',
                'dataset_hash',
                'candidate_content',
                'evidence',
                'promotion_status',
                'promotion_reason',
                'reviewed_by',
                'promoted_at'
            )
        GROUP BY table_schema, table_name
        HAVING count(*) = 8
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_dataset_shape_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_promotion_status_check'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
            AND indexname = 'prompt_optimization_jobs_review_required_idx'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'prompt_optimization_dataset_immutable' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'held-out optimization dataset persistence is incomplete';
    END IF;
    INSERT INTO prompt_optimization_jobs (
        id,
        project_id,
        prompt_id,
        prompt_slug,
        source_version,
        target_role,
        source_messages,
        evaluator,
        examples,
        dataset,
        dataset_hash,
        model_config,
        budget,
        status,
        requested_by
    ) VALUES (
        'aaaaaaaa-0000-4000-8000-000000000023',
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'first-prompt',
        1,
        'system',
        '[{"role":"system","content":"Hello {{name}}"}]',
        '{"type":"default_adapter"}',
        '[]',
        '{"version":1,"rubric":"Preserve task deadlines.","training_examples":[{"input":"training","answer":"training label"}],"validation_examples":[{"input":"held-out","answer":"held-out label"}]}',
        repeat('a', 64),
        '{"task_lm":"task","reflection_lm":"reflection"}',
        '{"max_metric_calls":2}',
        'completed',
        'migration-test'
    );
    BEGIN
        UPDATE prompt_optimization_jobs
        SET dataset = '{"version":1,"rubric":"mutated","training_examples":[],"validation_examples":[]}'
        WHERE id = 'aaaaaaaa-0000-4000-8000-000000000023';
        RAISE EXCEPTION 'optimization dataset snapshot accepted mutation';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
            AND table_name = 'prompt_optimization_jobs'
            AND column_name = 'metric_calls_used'
            AND data_type = 'integer'
            AND is_nullable = 'YES'
    ) THEN
        RAISE EXCEPTION 'prompt optimization metric-call column was not created as nullable integer';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'prompt_optimization_jobs'::regclass
            AND conname = 'prompt_optimization_jobs_metric_calls_used_check'
            AND pg_get_constraintdef(oid) LIKE '%metric_calls_used >= 0%'
    ) THEN
        RAISE EXCEPTION 'prompt optimization metric-call check was not created';
    END IF;
	INSERT INTO prompt_optimization_jobs (
		id, project_id, prompt_id, prompt_slug, source_version, target_role,
		source_messages, evaluator, examples, dataset, dataset_hash, model_config, budget, status,
		requested_by, metric_calls_used
    )
    SELECT
        'f1000000-0000-4000-8000-000000000001',
        p.project_id,
        p.id,
        p.slug,
        1,
        'system',
		'[{"role":"system","content":"source"}]'::jsonb,
		'{}'::jsonb,
		'[]'::jsonb,
		'{"version":0,"rubric":"Legacy optimization dataset; held-out validation was not recorded.","training_examples":[],"validation_examples":[]}'::jsonb,
		repeat('b', 64),
		'{}'::jsonb,
        '{"max_metric_calls":5}'::jsonb,
        'completed',
        'migration-test',
        NULL
    FROM prompts p
    ORDER BY p.created_at, p.id
    LIMIT 1;
    IF (SELECT metric_calls_used FROM prompt_optimization_jobs WHERE id = 'f1000000-0000-4000-8000-000000000001') IS NOT NULL THEN
        RAISE EXCEPTION 'legacy prompt optimization telemetry was not preserved as unavailable';
    END IF;
    UPDATE prompt_optimization_jobs
    SET metric_calls_used = 3
    WHERE id = 'f1000000-0000-4000-8000-000000000001';
    BEGIN
        UPDATE prompt_optimization_jobs
        SET metric_calls_used = -1
        WHERE id = 'f1000000-0000-4000-8000-000000000001';
        RAISE EXCEPTION 'prompt optimization metric-call check accepted a negative value';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;
    IF NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE id = '00000000-0000-4000-8000-000000000001'
            AND slug = 'default'
    ) THEN
        RAISE EXCEPTION 'default organization was not seeded';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM projects
        WHERE organization_id <> '00000000-0000-4000-8000-000000000001'
    ) THEN
        RAISE EXCEPTION 'legacy projects were not backfilled to the default organization';
    END IF;
    BEGIN
        INSERT INTO projects (name, slug, organization_id)
        VALUES ('Invalid Organization Project', 'invalid-organization', '00000000-0000-4000-8000-000000000099');
        RAISE EXCEPTION 'project organization foreign key accepted an unknown organization';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    INSERT INTO organizations (id, name, slug)
    VALUES ('00000000-0000-4000-8000-000000000002', 'Second Organization', 'second')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (
        '33333333-3333-4333-8333-333333333333',
        'Second Organization Default',
        'default',
        '00000000-0000-4000-8000-000000000002'
    );
    IF (SELECT count(*) FROM projects WHERE slug = 'default') <> 2 THEN
        RAISE EXCEPTION 'project slugs are not organization-scoped';
    END IF;

    IF (
        NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%added_to_dataset%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%dataset_id IS NULL%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND contype = 'f'
            AND pg_get_constraintdef(oid) LIKE '%dataset_items%'
            AND pg_get_constraintdef(oid) LIKE '%RESTRICT%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_idempotency'::regclass
            AND contype = 'p'
            AND pg_get_constraintdef(oid) LIKE '%project_id, idempotency_key%'
    ) OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'feedback_reviews'::regclass AND contype = 'f') < 4
        OR (SELECT count(*) FROM pg_constraint WHERE conrelid = 'feedback_idempotency'::regclass AND contype = 'f') < 2
    ) THEN
        RAISE EXCEPTION 'feedback constraints or idempotency uniqueness are incomplete';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_scores_feedback_target')
        OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_feedback_reviews_project_status')
        OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'scores_human_feedback_immutable' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'feedback indexes or immutability trigger are incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'dataset_items' AND column_name = 'feedback_score_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'dataset_items_feedback_score_id_unique'
            AND indexdef LIKE 'CREATE UNIQUE INDEX%'
    ) THEN
        RAISE EXCEPTION 'feedback promotion idempotency constraint is incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_score_project_fk'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_dataset_project_fk'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'feedback_reviews'::regclass
            AND conname = 'feedback_reviews_dataset_item_dataset_fk'
    ) THEN
        RAISE EXCEPTION 'feedback project scope constraints are incomplete';
    END IF;

    INSERT INTO datasets (id, project_id, name) VALUES
        ('a1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-a'),
        ('a2000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-b'),
        ('b1000000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'feedback-scope-other');
    INSERT INTO dataset_items (id, dataset_id, input) VALUES
        ('a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', '{}'),
        ('a2000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', '{}'),
        ('b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', '{}');
    INSERT INTO scores (id, project_id, trace_id, name, value, metadata) VALUES
        ('c1000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-1', 'human.feedback', -1, '{}'),
        ('c2000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-2', 'human.feedback', -1, '{}'),
        ('c3000000-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'feedback-scope-score-3', 'human.feedback', -1, '{}');
    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status)
        VALUES ('c1000000-0000-4000-8000-000000000001', '22222222-2222-2222-2222-222222222222', 'new');
        RAISE EXCEPTION 'feedback review accepted a score from another project';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_item_id)
        VALUES (
            'c2000000-0000-4000-8000-000000000001',
            '11111111-1111-1111-1111-111111111111',
            'added_to_dataset',
            'b1000000-0000-4000-8000-000000000001',
            'b1000000-0000-4000-8000-000000000002'
        );
        RAISE EXCEPTION 'feedback review accepted a dataset from another project';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    BEGIN
        INSERT INTO feedback_reviews (score_id, project_id, status, dataset_id, dataset_item_id)
        VALUES (
            'c3000000-0000-4000-8000-000000000001',
            '11111111-1111-1111-1111-111111111111',
            'added_to_dataset',
            'a1000000-0000-4000-8000-000000000001',
            'a2000000-0000-4000-8000-000000000002'
        );
        RAISE EXCEPTION 'feedback review accepted a dataset item from another dataset';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
    INSERT INTO scores (id, project_id, trace_id, name, value, metadata)
    VALUES ('99999999-9999-4999-8999-999999999999', '11111111-1111-1111-1111-111111111111', 'feedback-trace', 'human.feedback', -1, '{}');
    BEGIN
        UPDATE scores SET value = 1 WHERE id = '99999999-9999-4999-8999-999999999999';
        RAISE EXCEPTION 'human feedback score accepted a mutation';
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE <> 'P0001' THEN RAISE; END IF;
    END;
    IF NOT EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = 'a6000000-0000-4000-8000-000000000001'
            AND dataset_item_id = 'a5000000-0000-4000-8000-000000000001'
            AND status = 'completed' AND completed_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = 'a6000000-0000-4000-8000-000000000001'
            AND dataset_item_id = 'a5000000-0000-4000-8000-000000000002'
            AND status = 'pending'
    ) OR NOT EXISTS (
        SELECT 1 FROM experiments
        WHERE id = 'a6000000-0000-4000-8000-000000000001' AND status = 'completed'
    ) THEN
        RAISE EXCEPTION 'experiment task backfill did not preserve completed results';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'experiment_tasks'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%experiment_id, dataset_item_id%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass AND contype = 'u'
            AND pg_get_constraintdef(oid) LIKE '%experiment_id, dataset_item_id%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'experiment_tasks_claimable_idx'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'experiments_seed_tasks' AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'durable experiment task ledger is incomplete';
    END IF;
END
$$;
