DO $$
BEGIN
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
            AND change_message IS NULL
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
        RAISE EXCEPTION 'invalid label bindings were not all quarantined';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'invalid!' AND reason = 'invalid_label_format')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'latest' AND reason = 'reserved_latest')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'tenant' AND reason = 'prompt_project_mismatch')
        OR NOT EXISTS (SELECT 1 FROM prompt_label_quarantine WHERE original_label = 'version-link' AND reason = 'version_prompt_mismatch') THEN
        RAISE EXCEPTION 'label quarantine reason precedence is incorrect';
    END IF;
    IF (SELECT count(*) FROM prompt_labels) <> 1
        OR NOT EXISTS (SELECT 1 FROM prompt_labels WHERE label = 'production') THEN
        RAISE EXCEPTION 'valid labels were not retained exactly';
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
            AND content_hash = 'd94a7ccb5ecb9f8bb2ddac243bb4c31f6a33a2651e0d4573250701c450fcddf4'
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
    BEGIN
        UPDATE prompt_versions
        SET content = 'Changed'
        WHERE prompt_id = 'aaaaaaaa-0000-0000-0000-000000000001' AND version = 3;
        RAISE EXCEPTION 'immutable prompt version accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
END
$$;
