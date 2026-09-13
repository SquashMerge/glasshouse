DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_inputs
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND execution_bounds = '{"max_active_runs_per_project":4,"max_active_runs_per_actor":2,"max_cases":100,"max_provider_calls":100}'::jsonb
    ) THEN
        RAISE EXCEPTION '0095 did not add safe immutable bounds to a historical Evaluation Run';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_capacity_admissions
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION '0095 did not retain capacity for a historical running Evaluation Run';
    END IF;
    UPDATE evaluation_runs
    SET status = 'failed', terminal_reason = 'upgrade_test'
    WHERE id = '95000000-0000-4000-8000-000000000008';
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_capacity_admissions
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND status = 'released'
          AND release_reason = 'upgrade_test'
    ) THEN
        RAISE EXCEPTION '0095 did not release historical capacity at terminalization';
    END IF;
END $$;
