DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id = '91000000-0000-4000-8000-000000000012'
          AND evaluation_run_id = '91000000-0000-4000-8000-000000000010'
          AND evaluation_run_item_id = '91000000-0000-4000-8000-000000000011'
    ) THEN
        RAISE EXCEPTION 'post-0091 upgrade did not preserve the occupied target task';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id IN (
                '91000000-0000-4000-8000-000000000013',
                '91000000-0000-4000-8000-000000000016',
                '91000000-0000-4000-8000-000000000017'
            )
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'post-0091 preflight retained a half-scoped task link';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        JOIN experiment_tasks AS task ON task.id = quarantine.task_id
        WHERE task.experiment_id = '91000000-0000-4000-8000-000000000013'
          AND quarantine.evaluation_run_item_id IS NULL
          AND quarantine.remediated_evaluation_run_item_id IS NULL
          AND quarantine.reason = 'deterministic_run_item_occupied'
    ) THEN
        RAISE EXCEPTION 'post-0091 remediation did not quarantine the occupied target';
    END IF;
    IF (
        SELECT count(*)
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        JOIN experiment_tasks AS task ON task.id = quarantine.task_id
        WHERE task.experiment_id IN (
                '91000000-0000-4000-8000-000000000016',
                '91000000-0000-4000-8000-000000000017'
            )
          AND quarantine.evaluation_run_item_id IS NULL
          AND quarantine.remediated_evaluation_run_item_id IS NULL
          AND quarantine.reason = 'deterministic_run_item_remap_collision'
    ) <> 2 THEN
        RAISE EXCEPTION '0092 did not quarantine every unoccupied-target remap collision';
    END IF;
END $$;
