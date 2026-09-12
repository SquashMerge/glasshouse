DO $$
DECLARE
    valid_task_id UUID;
BEGIN
    SELECT id INTO valid_task_id
    FROM experiment_tasks
    WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
      AND dataset_version_item_id = '90000000-0000-4000-8000-000000000021';

    IF valid_task_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE id = valid_task_id
          AND evaluation_run_id = '90000000-0000-4000-8000-000000000010'
          AND evaluation_run_item_id = '90000000-0000-4000-8000-000000000022'
    ) THEN
        RAISE EXCEPTION 'upgrade did not preserve the valid task Run-item association';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
          AND dataset_version_item_id IN (
              '90000000-0000-4000-8000-000000000007',
              '90000000-0000-4000-8000-000000000018'
          )
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'upgrade retained an occupied or Dataset-misassociated task Run-item link';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        JOIN experiment_tasks AS task ON task.id = quarantine.task_id
        WHERE task.dataset_version_item_id = '90000000-0000-4000-8000-000000000007'
          AND quarantine.reason = 'deterministic_run_item_occupied'
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        JOIN experiment_tasks AS task ON task.id = quarantine.task_id
        WHERE task.dataset_version_item_id = '90000000-0000-4000-8000-000000000018'
          AND quarantine.reason = 'run_item_dataset_version_item_mismatch'
    ) THEN
        RAISE EXCEPTION 'upgrade did not quarantine both malformed task relationships';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id IN (
                '90000000-0000-4000-8000-000000000015',
                '90000000-0000-4000-8000-000000000020'
            )
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '90000000-0000-4000-8000-000000000015'
          AND output = '{"output":"collision-preserved"}'::jsonb
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '90000000-0000-4000-8000-000000000020'
          AND output = '{"output":"misassociation-preserved"}'::jsonb
    ) THEN
        RAISE EXCEPTION 'upgrade did not fail closed while preserving result evidence';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks AS task
        WHERE task.evaluation_run_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM evaluation_run_items AS item
              WHERE item.id = task.evaluation_run_item_id
                AND item.project_id = task.project_id
                AND item.run_id = task.evaluation_run_id
                AND item.dataset_version_item_id = task.dataset_version_item_id
          )
    ) OR EXISTS (
        SELECT 1
        FROM experiment_results AS result
        WHERE result.evaluation_run_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM evaluation_run_items AS item
              WHERE item.id = result.evaluation_run_item_id
                AND item.project_id = result.project_id
                AND item.run_id = result.evaluation_run_id
                AND item.dataset_version_item_id = result.dataset_version_item_id
          )
    ) THEN
        RAISE EXCEPTION 'upgrade left an unprovable Run-item Dataset-version-item association';
    END IF;

    BEGIN
        UPDATE experiment_tasks
        SET evaluation_run_item_id = '90000000-0000-4000-8000-000000000019'
        WHERE id = valid_task_id;
        RAISE EXCEPTION 'task Run-item FK accepted a different Dataset-version item';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    BEGIN
        UPDATE experiment_results
        SET evaluation_run_id = '90000000-0000-4000-8000-000000000010',
            evaluation_run_item_id = '90000000-0000-4000-8000-000000000019'
        WHERE id = '90000000-0000-4000-8000-000000000015';
        RAISE EXCEPTION 'result Run-item FK accepted a different Dataset-version item';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;

DO $$
BEGIN
    BEGIN
        UPDATE agent_introspection_reports
        SET request_hash = repeat('b', 64)
        WHERE id = '90000000-0000-4000-8000-000000000016';
        RAISE EXCEPTION 'immutable report accepted an update';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    BEGIN
        INSERT INTO agent_introspection_reports (
            organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
            task_id, invocation_id, reported_by_actor_id, contract_version, source,
            outcome, completeness, request_hash, report
        )
        SELECT organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
               task_id, invocation_id, reported_by_actor_id, contract_version, source,
               outcome, completeness, request_hash, report
        FROM agent_introspection_reports
        WHERE id = '90000000-0000-4000-8000-000000000016';
        RAISE EXCEPTION 'report invocation identity accepted a duplicate';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
END $$;
