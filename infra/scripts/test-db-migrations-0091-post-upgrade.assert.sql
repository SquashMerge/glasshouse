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
        WHERE experiment_id = '91000000-0000-4000-8000-000000000013'
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'post-0091 preflight retained the Run-only task link';
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
END $$;
