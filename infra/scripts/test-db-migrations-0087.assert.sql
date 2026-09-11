DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'evaluation_run_inputs'
          AND column_name = 'evaluator_fingerprint'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0087 evaluator fingerprint column is missing or nullable';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'evaluation_run_inputs_evaluator_fingerprint_check'
    ) THEN
        RAISE EXCEPTION '0087 evaluator fingerprint format constraint is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE relname = 'evaluation_run_inputs_evaluator_fingerprint_idx'
          AND relkind = 'i'
    ) THEN
        RAISE EXCEPTION '0087 evaluator fingerprint index is missing';
    END IF;
END $$;
