DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'agent_introspection_reports') THEN
        RAISE EXCEPTION 'agent introspection report table is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'agent_introspection_reports'::regclass AND tgname = 'agent_introspection_reports_immutable' AND NOT tgisinternal) THEN
        RAISE EXCEPTION 'agent introspection report immutability trigger is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'agent_introspection_reports'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%experiment_tasks%') THEN
        RAISE EXCEPTION 'agent introspection task scope foreign key is missing';
    END IF;
END $$;
