DO $$
BEGIN
    IF to_regclass('local_sessions') IS NULL OR to_regclass('local_login_limits') IS NULL OR to_regclass('local_auth_audit_events') IS NULL THEN
        RAISE EXCEPTION 'local session schema missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'local_sessions_actor_idx')
        OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'local_sessions_expiry_idx') THEN
        RAISE EXCEPTION 'session cleanup indexes missing';
    END IF;
    IF EXISTS (SELECT 1 FROM local_credentials WHERE auth_version <> 1)
        OR EXISTS (SELECT 1 FROM local_sessions) OR EXISTS (SELECT 1 FROM local_login_limits) THEN
        RAISE EXCEPTION 'migration must not import passwords or create sessions';
    END IF;
    IF (SELECT count(*) FROM information_schema.columns WHERE table_name = 'local_sessions' AND column_name IN ('organization_id', 'actor_id', 'token_digest', 'auth_version') AND is_nullable = 'NO') <> 4 THEN
        RAISE EXCEPTION 'session tenant and credential provenance must be non-null';
    END IF;
END;
$$;
