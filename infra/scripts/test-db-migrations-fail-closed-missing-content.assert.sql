DO $$
BEGIN
    IF (SELECT messages FROM prompt_versions WHERE id = '55555555-0000-0000-0000-000000000101')
        <> '[{"role":"user"}]'::jsonb THEN
        RAISE EXCEPTION 'preflight failure modified missing-content messages';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prompts' AND column_name = 'role'
    ) THEN
        RAISE EXCEPTION 'missing-content preflight failure added the prompts role column';
    END IF;
END
$$;
