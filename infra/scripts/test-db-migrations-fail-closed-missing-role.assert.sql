DO $$
BEGIN
    IF (SELECT messages FROM prompt_versions WHERE id = '44444444-0000-0000-0000-000000000101')
        <> '[{"content":"missing role source"}]'::jsonb THEN
        RAISE EXCEPTION 'preflight failure modified missing-role messages';
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prompts' AND column_name = 'role'
    ) THEN
        RAISE EXCEPTION 'missing-role preflight failure added the prompts role column';
    END IF;
END
$$;
