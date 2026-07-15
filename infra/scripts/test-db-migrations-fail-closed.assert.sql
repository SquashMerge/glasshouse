DO $$
BEGIN
    IF (SELECT content FROM prompt_versions WHERE id = 'eeeeeeee-0000-0000-0000-000000000101') <> 'legacy source' THEN
        RAISE EXCEPTION 'preflight failure modified legacy source';
    END IF;
    IF (SELECT messages FROM prompt_versions WHERE id = 'eeeeeeee-0000-0000-0000-000000000101')
        <> '[{"role":"system","content":"one"},{"role":"user","content":"two"}]'::jsonb THEN
        RAISE EXCEPTION 'preflight failure modified legacy messages';
    END IF;
    IF (SELECT messages FROM prompt_versions WHERE id = 'ffffffff-0000-0000-0000-000000000102')
        <> '[{"role":"user","content":"user source"}]'::jsonb THEN
        RAISE EXCEPTION 'preflight failure modified role-inconsistent messages';
    END IF;
END
$$;
