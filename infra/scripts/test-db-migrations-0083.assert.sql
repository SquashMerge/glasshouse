DO $$
BEGIN
    IF to_regclass('public.evaluation_run_events') IS NULL THEN
        RAISE EXCEPTION '0083 did not create Evaluation Run lifecycle events';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'experiment_tasks' AND column_name = 'max_attempts'
    ) THEN
        RAISE EXCEPTION '0083 did not add task attempt limits';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'experiment_tasks' AND column_name = 'heartbeat_at'
    ) THEN
        RAISE EXCEPTION '0083 did not add task heartbeat state';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'experiment_results' AND column_name = 'trace_id'
    ) THEN
        RAISE EXCEPTION '0083 did not add result trace evidence';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'evaluation_run_inputs' AND column_name = 'limits'
    ) THEN
        RAISE EXCEPTION '0083 did not retain immutable run limits';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'evaluation_run_status_transition'
    ) THEN
        RAISE EXCEPTION '0083 did not install Run transition guard';
    END IF;
END $$;
