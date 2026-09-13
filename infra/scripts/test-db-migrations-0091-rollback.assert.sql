DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM agent_introspection_reports
        WHERE id = '90000000-0000-4000-8000-000000000031'
    ) OR NOT EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id = '90000000-0000-4000-8000-000000000014'
          AND dataset_version_item_id = '90000000-0000-4000-8000-000000000007'
          AND evaluation_run_id = '90000000-0000-4000-8000-000000000010'
          AND evaluation_run_item_id = '90000000-0000-4000-8000-000000000013'
    ) OR to_regclass('public.experiment_task_run_item_mismatch_quarantine') IS NOT NULL THEN
        RAISE EXCEPTION 'failed migration committed pre-0091 collision remediation';
    END IF;
END $$;
