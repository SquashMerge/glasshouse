DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluations'
          AND column_name = 'tombstoned_at'
    ) THEN
        RAISE EXCEPTION '0076 did not add the evaluation tombstone timestamp';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'evaluations'::regclass
          AND tgname = 'evaluations_hard_delete_guard'
    ) THEN
        RAISE EXCEPTION '0076 did not install the evaluation hard deletion guard';
    END IF;
END
$$;
