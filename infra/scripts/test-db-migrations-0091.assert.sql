DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'evaluation_run_items'::regclass
          AND conname = 'evaluation_run_items_id_project_run_key'
          AND contype = 'u'
    ) THEN
        RAISE EXCEPTION '0091 Run-item identity key is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass
          AND conname = 'experiment_tasks_evaluation_run_item_run_fkey'
          AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (evaluation_run_item_id, project_id, evaluation_run_id)%REFERENCES evaluation_run_items(id, project_id, run_id)%'
    ) THEN
        RAISE EXCEPTION '0091 task Run-item composite scope FK is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agent_introspection_reports'::regclass
          AND conname = 'agent_introspection_reports_task_scope_fkey'
          AND pg_get_constraintdef(oid) LIKE '%REFERENCES experiment_tasks(id, project_id, evaluation_run_id, evaluation_run_item_id)%'
    ) THEN
        RAISE EXCEPTION '0091 report task scope FK is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'agent_introspection_reports'::regclass
          AND conname = 'agent_introspection_reports_run_item_scope_fkey'
          AND pg_get_constraintdef(oid) LIKE '%REFERENCES evaluation_run_items(id, project_id, run_id)%'
    ) THEN
        RAISE EXCEPTION '0091 report Run-item scope FK is missing';
    END IF;
    IF to_regclass('public.experiment_task_run_item_mismatch_quarantine') IS NULL
       OR to_regclass('public.agent_introspection_report_scope_quarantine') IS NULL THEN
        RAISE EXCEPTION '0091 scope remediation quarantine is missing';
    END IF;
    IF EXISTS (SELECT 1 FROM agent_introspection_reports) THEN
        RAISE EXCEPTION '0091 unexpectedly backfilled a report for a legacy Run';
    END IF;
END $$;
