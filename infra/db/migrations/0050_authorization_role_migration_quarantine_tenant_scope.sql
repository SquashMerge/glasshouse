DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM authorization_role_migration_quarantine
        WHERE organization_id IS NULL
    ) THEN
        RAISE EXCEPTION 'authorization role migration quarantine rows missing organization scope';
    END IF;
END;
$$;

ALTER TABLE authorization_role_migration_quarantine
    ALTER COLUMN organization_id SET NOT NULL;
