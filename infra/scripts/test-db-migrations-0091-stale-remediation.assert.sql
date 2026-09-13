DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM experiment_task_run_item_mismatch_quarantine AS quarantine
        JOIN experiment_tasks AS task ON task.id = quarantine.task_id
        WHERE task.experiment_id = '91000000-0000-4000-8000-000000000013'
          AND quarantine.quarantined_at = '2026-01-01T00:00:00Z'
    ) THEN
        RAISE EXCEPTION 'post-0091 remediation replaced quarantine audit provenance';
    END IF;
END $$;
