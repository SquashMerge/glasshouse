DO $$
DECLARE
    repaired_project_id UUID;
BEGIN
    SELECT project_id INTO repaired_project_id
    FROM project_authorization_audit_events
    WHERE organization_id = '00000000-0000-4000-8000-000000000028'
        AND actor_subject = 'migration-audit-repair';

    IF repaired_project_id IS NULL
        OR NOT EXISTS (
            SELECT 1
            FROM projects
            WHERE id = repaired_project_id
                AND organization_id = '00000000-0000-4000-8000-000000000028'
                AND slug = 'default'
        ) THEN
        RAISE EXCEPTION 'authorization audit null project was not repaired within its organization';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'project_authorization_audit_events'::regclass
            AND conname = 'project_authorization_audit_events_project_organization_fkey'
            AND pg_get_constraintdef(oid) LIKE '%FOREIGN KEY (project_id, organization_id)%'
    ) THEN
        RAISE EXCEPTION 'authorization audit project organization foreign key was not repaired';
    END IF;

    BEGIN
        INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
        VALUES (
            '00000000-0000-4000-8000-000000000028',
            NULL,
            'migration-audit-null',
            'organization_membership_updated'
        );
        RAISE EXCEPTION 'authorization audit accepted a null project';
    EXCEPTION WHEN not_null_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO project_authorization_audit_events (organization_id, project_id, actor_subject, event_type)
        VALUES (
            '00000000-0000-4000-8000-000000000028',
            '11111111-1111-1111-1111-111111111111',
            'migration-audit-cross-org',
            'organization_membership_updated'
        );
        RAISE EXCEPTION 'authorization audit accepted a cross-organization project after repair';
    EXCEPTION WHEN foreign_key_violation THEN
        NULL;
    END;
END
$$;
