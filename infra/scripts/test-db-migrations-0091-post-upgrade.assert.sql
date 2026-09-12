DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id IN (
                '91000000-0000-4000-8000-000000000012',
                '91000000-0000-4000-8000-000000000013'
            )
          AND (evaluation_run_id IS NOT NULL OR evaluation_run_item_id IS NOT NULL)
    ) THEN
        RAISE EXCEPTION 'post-0091 preflight retained converging Run-only task links';
    END IF;
    IF (SELECT count(*) FROM experiment_task_run_item_mismatch_quarantine
        WHERE reason = 'deterministic_run_item_remap_collision') <> 2 THEN
        RAISE EXCEPTION 'post-0091 preflight did not quarantine both converging Run-only tasks';
    END IF;
END $$;
