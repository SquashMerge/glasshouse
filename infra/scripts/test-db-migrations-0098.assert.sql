DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM local_credentials) OR EXISTS (SELECT 1 FROM local_account_enrollments)
        OR EXISTS (SELECT 1 FROM local_bootstrap_controls WHERE token_digest IS NOT NULL) THEN
        RAISE EXCEPTION 'migration imported credentials or provisioned a secret';
    END IF;
    IF EXISTS (
        SELECT 1 FROM organizations organization LEFT JOIN local_bootstrap_controls control ON control.organization_id = organization.id
        WHERE control.organization_id IS NULL OR (control.closed_at IS NOT NULL) IS DISTINCT FROM
            EXISTS (SELECT 1 FROM organization_actor_roles role WHERE role.organization_id = organization.id AND role.role = 'admin')
    ) THEN
        RAISE EXCEPTION 'bootstrap availability does not match existing Admin state';
    END IF;
END;
$$;
