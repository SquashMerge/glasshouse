DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'evaluation_run_inputs' AND column_name = 'limits'
    ) THEN
        RAISE EXCEPTION '0084 did not add immutable run limits to existing databases';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'evaluation_run_inputs_limits_check'
    ) THEN
        RAISE EXCEPTION '0084 did not constrain immutable run limits';
    END IF;
END $$;
