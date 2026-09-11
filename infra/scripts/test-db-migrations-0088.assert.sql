DO $$
BEGIN
    IF to_regclass('public.evaluation_gate_approvals') IS NULL
       OR to_regclass('public.evaluation_gate_runs') IS NULL
       OR to_regclass('public.evaluation_gate_audit_events') IS NULL THEN
        RAISE EXCEPTION '0088 Evaluation Gate tables are missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'evaluation_gate_approvals_active_scope_idx' AND relkind = 'i'
    ) THEN
        RAISE EXCEPTION '0088 active approval uniqueness index is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'evaluation_gate_approvals'::regclass
          AND conkey = ARRAY[
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'evaluation_gate_approvals'::regclass AND attname = 'superseded_by'),
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'evaluation_gate_approvals'::regclass AND attname = 'project_id')
          ]
          AND condeferrable
          AND condeferred
    ) THEN
        RAISE EXCEPTION '0088 supersession foreign key must defer until replacement approval insertion';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'evaluation_gate_outcome_sync'
    ) THEN
        RAISE EXCEPTION '0088 gate outcome trigger is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluation_gate_approvals'
          AND column_name = 'definition_version_id'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0088 approval immutable Definition Version binding is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluation_gate_runs'
          AND column_name IN ('selected_count', 'evaluated_count', 'passed_count', 'failed_count')
        GROUP BY table_name
        HAVING count(*) = 4
    ) THEN
        RAISE EXCEPTION '0088 gate outcome counts are missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'sync_evaluation_gate_outcome'
          AND prosrc LIKE '%incomplete_evidence%'
    ) THEN
        RAISE EXCEPTION '0088 incomplete evidence gate outcome is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE proname = 'authorization_allows_project'
          AND prosrc LIKE '%release_gate_manage%'
    ) THEN
        RAISE EXCEPTION '0088 Admin-only release_gate_manage authorization is missing';
    END IF;
END $$;
