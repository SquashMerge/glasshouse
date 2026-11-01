DO $$
DECLARE
    target_organization_id UUID;
BEGIN
    SELECT id INTO target_organization_id FROM organizations WHERE slug = 'default';

    IF NOT EXISTS (
        SELECT 1 FROM internal_log_entries
        WHERE id = '90058000-0000-4000-8000-000000000001'
          AND organization_id = target_organization_id
          AND to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = '2026-11-01T00:01:00.123456Z'
    ) THEN
        RAISE EXCEPTION 'internal log migration did not retain tenant scope or microsecond timestamp precision';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'internal_log_entries_recorded_at_idx'
    ) THEN
        RAISE EXCEPTION 'internal log cleanup index is missing';
    END IF;

    BEGIN
        INSERT INTO internal_log_entries (organization_id, severity, source, message, context)
        VALUES ('00000000-0000-4000-8000-000000000099', 'info', 'api', 'API request outcome', '{}'::jsonb);
        RAISE EXCEPTION 'internal log organization foreign key was not enforced';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO internal_log_entries (organization_id, severity, source, message, context)
        VALUES (target_organization_id, 'info', 'api', 'HTTP GET /v1/customer-secret', '{}'::jsonb);
        RAISE EXCEPTION 'internal log message allowlist was not enforced';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END;
$$;
