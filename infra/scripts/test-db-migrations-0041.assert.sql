DO $$
DECLARE
    test_organization_id CONSTANT UUID := '66666666-6666-4666-8666-666666666666';
    test_project_id CONSTANT UUID := '66666666-6666-4666-8666-666666666665';
    test_admin_actor_id CONSTANT UUID := '66666666-6666-4666-8666-666666666601';
    test_user_actor_id CONSTANT UUID := '66666666-6666-4666-8666-666666666602';
    test_reader_actor_id CONSTANT UUID := '66666666-6666-4666-8666-666666666603';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM authorization_role_migration_audit
        WHERE organization_id = test_organization_id
          AND actor_subject = 'legacy-admin'
          AND effective_role = 'admin'
    ) OR NOT EXISTS (
        SELECT 1 FROM authorization_role_migration_audit
        WHERE project_id = test_project_id
          AND actor_subject = 'legacy-user'
          AND effective_role = 'user'
    ) OR NOT EXISTS (
        SELECT 1 FROM authorization_role_migration_audit
        WHERE project_id = test_project_id
          AND actor_subject = 'legacy-reader'
          AND effective_role = 'read_only'
    ) THEN
        RAISE EXCEPTION '0041 did not record all valid legacy role mappings';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM authorization_role_migration_quarantine
        WHERE organization_id = test_organization_id
          AND actor_subject = 'unmapped-legacy-subject'
          AND reason = 'unmapped_legacy_subject'
          AND resolved_at IS NULL
    ) THEN
        RAISE EXCEPTION '0041 did not quarantine an unmapped legacy subject';
    END IF;

    IF (SELECT strict_enforcement FROM authorization_policy_settings WHERE organization_id = test_organization_id) THEN
        RAISE EXCEPTION '0041 enabled strict enforcement automatically';
    END IF;
    IF NOT authorization_allows_project(test_organization_id, test_project_id, test_reader_actor_id, 'product_write') THEN
        RAISE EXCEPTION 'compatibility mode unexpectedly revoked legacy member writes';
    END IF;

    BEGIN
        PERFORM enable_admin_user_read_only_enforcement(test_organization_id);
        RAISE EXCEPTION '0041 enabled strict enforcement with unresolved quarantine';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'unresolved authorization role migration quarantine' THEN
            RAISE;
        END IF;
    END;

    UPDATE authorization_role_migration_quarantine
    SET resolved_at = now()
    WHERE organization_id = test_organization_id;
    PERFORM enable_admin_user_read_only_enforcement(test_organization_id);
    PERFORM enable_admin_user_read_only_enforcement(test_organization_id);

    IF NOT (SELECT strict_enforcement FROM authorization_policy_settings WHERE organization_id = test_organization_id)
        OR authorization_allows_project(test_organization_id, test_project_id, test_reader_actor_id, 'product_write')
        OR authorization_allows_project(test_organization_id, test_project_id, test_user_actor_id, 'governed')
        OR NOT authorization_allows_project(test_organization_id, test_project_id, test_user_actor_id, 'execute')
        OR NOT authorization_allows_project(test_organization_id, test_project_id, test_admin_actor_id, 'destructive')
        OR authorization_allows_project(test_organization_id, test_project_id, test_admin_actor_id, 'unknown') THEN
        RAISE EXCEPTION '0041 strict policy operation matrix is incorrect';
    END IF;

    BEGIN
        UPDATE organization_memberships
        SET role = 'member'
        WHERE organization_id = test_organization_id
          AND actor_subject = 'legacy-admin';
        RAISE EXCEPTION '0041 allowed final Admin demotion';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'cannot remove or demote the final organization Admin' THEN
            RAISE;
        END IF;
    END;
END
$$;

ALTER TABLE organizations ALTER COLUMN default_project_id DROP NOT NULL;
INSERT INTO organizations (id, name, slug)
VALUES (
    '66666666-6666-4666-8666-666666666604',
    'Future Authorization Policy Organization',
    'future-authorization-policy-organization'
);
INSERT INTO projects (id, name, slug, organization_id)
VALUES (
    '66666666-6666-4666-8666-666666666605',
    'Future Authorization Policy Project',
    'future-authorization-policy-project',
    '66666666-6666-4666-8666-666666666604'
);
UPDATE organizations
SET default_project_id = '66666666-6666-4666-8666-666666666605'
WHERE id = '66666666-6666-4666-8666-666666666604';
ALTER TABLE organizations ALTER COLUMN default_project_id SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM authorization_policy_settings
        WHERE organization_id = '66666666-6666-4666-8666-666666666604'
          AND strict_enforcement = false
    ) THEN
        RAISE EXCEPTION '0041 did not initialize a future organization in compatibility mode';
    END IF;
END
$$;
