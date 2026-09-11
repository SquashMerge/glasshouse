DO $$
BEGIN
    IF pg_get_functiondef('sync_evaluation_run_status'::regproc)
       NOT LIKE '%terminal_reason = CASE%' THEN
        RAISE EXCEPTION '0086 does not preserve terminal reasons during status sync';
    END IF;
    IF pg_get_functiondef('sync_evaluation_run_status'::regproc)
       NOT LIKE '%evaluation_runs.terminal_reason%' THEN
        RAISE EXCEPTION '0086 status sync does not retain an explicit terminal reason';
    END IF;
END $$;
