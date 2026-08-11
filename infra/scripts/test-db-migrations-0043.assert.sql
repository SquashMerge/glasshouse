DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'authorization_organization_membership_revocation_fence'
          AND tgrelid = 'organization_memberships'::regclass
    ) THEN
        RAISE EXCEPTION '0043 did not fence organization membership revocation';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'authorization_project_membership_revocation_fence'
          AND tgrelid = 'project_memberships'::regclass
    ) THEN
        RAISE EXCEPTION '0043 did not fence project membership revocation';
    END IF;
END
$$;
