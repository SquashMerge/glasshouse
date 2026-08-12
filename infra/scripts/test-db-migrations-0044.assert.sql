DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'projects'
          AND column_name = 'authorization_epoch'
    ) THEN
        RAISE EXCEPTION '0044 did not add the project authorization epoch';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE relname = 'execution_admissions'
          AND relkind = 'r'
    ) THEN
        RAISE EXCEPTION '0044 did not create execution admissions';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'execution_admissions_project_scope_fkey'
          AND conrelid = 'execution_admissions'::regclass
    ) THEN
        RAISE EXCEPTION '0044 did not scope execution admissions to projects';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = 'execution_admissions_active_project_requester_idx'
          AND tablename = 'execution_admissions'
    ) THEN
        RAISE EXCEPTION '0044 did not index active execution admissions';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'project_execution_admission_archive_fence'
          AND tgrelid = 'projects'::regclass
    ) THEN
        RAISE EXCEPTION '0044 did not cancel admissions for archived projects';
    END IF;
END
$$;
