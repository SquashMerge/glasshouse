DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'dataset_items'::regclass
          AND conname = 'dataset_items_project_dataset_fkey'
          AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (project_id, dataset_id)%'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass
          AND conname = 'experiment_tasks_project_legacy_item_fkey'
          AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (project_id, dataset_item_id)%'
          AND pg_get_constraintdef(oid) LIKE '%REFERENCES dataset_items(project_id, id)%'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass
          AND conname = 'experiment_results_project_legacy_item_fkey'
          AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (project_id, dataset_item_id)%'
          AND pg_get_constraintdef(oid) LIKE '%REFERENCES dataset_items(project_id, id)%'
    ) THEN
        RAISE EXCEPTION 'legacy dataset item links are not project scoped';
    END IF;

    IF (SELECT project_id FROM dataset_items WHERE id = '64000000-0000-4000-8000-000000000011')
        <> '64000000-0000-4000-8000-000000000001'::uuid THEN
        RAISE EXCEPTION 'legacy dataset item project scope was not backfilled';
    END IF;

    IF (
        SELECT count(*)
        FROM experiment_legacy_item_link_quarantine
        WHERE (record_kind, record_id, project_id, experiment_id, dataset_item_id, dataset_item_project_id, reason) IN (
            (
                'task',
                '64000000-0000-4000-8000-000000000110'::uuid,
                '64000000-0000-4000-8000-000000000001'::uuid,
                '64000000-0000-4000-8000-000000000100'::uuid,
                '64000000-0000-4000-8000-000000000021'::uuid,
                '64000000-0000-4000-8000-000000000002'::uuid,
                'dataset_item_project_mismatch'
            ),
            (
                'result',
                '64000000-0000-4000-8000-000000000120'::uuid,
                '64000000-0000-4000-8000-000000000001'::uuid,
                '64000000-0000-4000-8000-000000000100'::uuid,
                '64000000-0000-4000-8000-000000000021'::uuid,
                '64000000-0000-4000-8000-000000000002'::uuid,
                'dataset_item_project_mismatch'
            )
        )
    ) <> 2 THEN
        RAISE EXCEPTION 'unsafe legacy experiment item links were not quarantined';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE id = '64000000-0000-4000-8000-000000000110'
    ) OR EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '64000000-0000-4000-8000-000000000120'
    ) OR (SELECT status FROM experiments WHERE id = '64000000-0000-4000-8000-000000000100') <> 'cancelled' THEN
        RAISE EXCEPTION 'unsafe legacy experiment work was not terminalized';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE id = '64000000-0000-4000-8000-000000000111'
          AND dataset_item_id = '64000000-0000-4000-8000-000000000011'::uuid
    ) THEN
        RAISE EXCEPTION 'valid legacy experiment item links were not retained';
    END IF;

    BEGIN
        INSERT INTO experiment_tasks (
            project_id,
            experiment_id,
            dataset_item_id
        ) VALUES (
            '64000000-0000-4000-8000-000000000001',
            '64000000-0000-4000-8000-000000000101',
            '64000000-0000-4000-8000-000000000021'
        );
        RAISE EXCEPTION 'cross-project legacy task link was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO experiment_results (
            project_id,
            experiment_id,
            dataset_item_id,
            scores
        ) VALUES (
            '64000000-0000-4000-8000-000000000001',
            '64000000-0000-4000-8000-000000000101',
            '64000000-0000-4000-8000-000000000021',
            '{}'::jsonb
        );
        RAISE EXCEPTION 'cross-project legacy result link was accepted';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
END;
$$;
