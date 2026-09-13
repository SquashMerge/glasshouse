DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_inputs
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND execution_bounds = '{"max_active_runs_per_project":4,"max_active_runs_per_actor":2,"max_requested_sample_size":100,"max_provider_calls":100}'::jsonb
    ) THEN
        RAISE EXCEPTION '0096 did not rename the immutable requested sample-size bound on a historical Evaluation Run';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_capacity_admissions
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND status = 'released'
          AND release_reason = 'recovery_reconciliation'
    ) THEN
        RAISE EXCEPTION '0097 did not require a historical running Evaluation Run to pass recovery admission again';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_runs
        WHERE id = '95000000-0000-4000-8000-000000000008'
          AND provider_call_count = 1
    ) THEN
        RAISE EXCEPTION '0097 did not conservatively backfill historical provider dispatch charges';
    END IF;
    UPDATE evaluation_runs
    SET status = 'failed', terminal_reason = 'upgrade_test'
    WHERE id = '95000000-0000-4000-8000-000000000008';
    IF NOT EXISTS (
        SELECT 1
        FROM evaluation_run_capacity_admissions
        WHERE run_id = '95000000-0000-4000-8000-000000000008'
          AND status = 'released'
          AND release_reason = 'recovery_reconciliation'
    ) THEN
        RAISE EXCEPTION '0097 did not preserve the released historical capacity during terminalization';
    END IF;
END $$;
