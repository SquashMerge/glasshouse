DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM authorization_role_migration_audit
        WHERE organization_id = '00000000-0000-4000-8000-000000000001'
          AND project_id IS NULL
          AND actor_subject = '0050-organization-audit'
    ) OR NOT EXISTS (
        SELECT 1
        FROM authorization_role_migration_quarantine
        WHERE organization_id = '00000000-0000-4000-8000-000000000001'
          AND project_id IS NULL
          AND actor_subject = '0050-organization-quarantine'
    ) THEN
        RAISE EXCEPTION '0050 did not retain organization-scoped role migration records';
    END IF;

    INSERT INTO authorization_role_migration_audit (
        source_table,
        organization_id,
        project_id,
        actor_subject,
        legacy_role,
        effective_role
    ) VALUES (
        'organization_memberships',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        '0050-post-migration-audit',
        'owner',
        'admin'
    );
    INSERT INTO authorization_role_migration_quarantine (
        source_table,
        organization_id,
        project_id,
        actor_subject,
        reason
    ) VALUES (
        'organization_memberships',
        '00000000-0000-4000-8000-000000000001',
        NULL,
        '0050-post-migration-quarantine',
        'unmapped_legacy_subject'
    );

    BEGIN
        INSERT INTO authorization_role_migration_quarantine (
            source_table,
            organization_id,
            project_id,
            actor_subject,
            reason
        ) VALUES (
            'organization_memberships',
            NULL,
            NULL,
            '0050-missing-organization-quarantine',
            'unmapped_legacy_subject'
        );
        RAISE EXCEPTION '0050 accepted a quarantine record without organization scope';
    EXCEPTION WHEN not_null_violation THEN
        NULL;
    END;
END;
$$;
