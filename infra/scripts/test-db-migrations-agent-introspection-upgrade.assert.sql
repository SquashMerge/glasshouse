DO $$
DECLARE
    valid_task_id UUID;
    safe_task_id UUID;
    collision_a_task_id UUID;
    collision_c_task_id UUID;
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

    SELECT id INTO safe_task_id
    FROM experiment_tasks
    WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
      AND dataset_version_item_id = '90000000-0000-4000-8000-000000000018';
    SELECT id INTO collision_a_task_id
    FROM experiment_tasks
    WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
      AND dataset_version_item_id = '90000000-0000-4000-8000-000000000007';
    SELECT id INTO collision_c_task_id
    FROM experiment_tasks
    WHERE experiment_id = '90000000-0000-4000-8000-000000000026'
      AND dataset_version_item_id = '90000000-0000-4000-8000-000000000007';

    IF safe_task_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE id = safe_task_id
          AND evaluation_run_id = '90000000-0000-4000-8000-000000000010'
          AND evaluation_run_item_id = '90000000-0000-4000-8000-000000000019'
    ) THEN
        RAISE EXCEPTION 'upgrade did not remap the non-conflicting task';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE id IN (collision_a_task_id, collision_c_task_id)
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'upgrade retained a conflicting task Run-item link';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        WHERE quarantine.task_id = collision_a_task_id
          AND quarantine.reason = 'deterministic_run_item_remap_collision'
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        WHERE quarantine.task_id = collision_c_task_id
          AND quarantine.reason = 'deterministic_run_item_remap_collision'
    ) THEN
        RAISE EXCEPTION 'upgrade did not quarantine both converging task remaps';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id IN (
                '90000000-0000-4000-8000-000000000015',
                '90000000-0000-4000-8000-000000000025'
            )
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '90000000-0000-4000-8000-000000000015'
          AND output = '{"output":"collision-a-preserved"}'::jsonb
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '90000000-0000-4000-8000-000000000025'
          AND output = '{"output":"collision-c-preserved"}'::jsonb
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE id = '90000000-0000-4000-8000-000000000020'
          AND evaluation_run_id = '90000000-0000-4000-8000-000000000010'
          AND evaluation_run_item_id = '90000000-0000-4000-8000-000000000019'
          AND output = '{"output":"safe-remap-preserved"}'::jsonb
    ) THEN
        RAISE EXCEPTION 'upgrade did not scope remediated and quarantined result evidence';
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
