DO $$
DECLARE
    function_definition TEXT := pg_get_functiondef('enforce_admin_access_audit_scope'::regproc);
    live_project_lock_position INTEGER;
    provenance_lock_position INTEGER;
    same_organization_check_position INTEGER;
BEGIN
    live_project_lock_position := strpos(
        function_definition,
        'FROM projects AS project
        WHERE project.id = NEW.project_id
        FOR KEY SHARE;'
    );
    provenance_lock_position := strpos(
        function_definition,
        'PERFORM lock_project_audit_provenance(NEW.project_id);'
    );
    same_organization_check_position := strpos(
        function_definition,
        'project.organization_id = NEW.organization_id
            FOR KEY SHARE'
    );

    IF function_definition NOT LIKE '%IF NEW.project_id IS NOT NULL THEN%'
       OR live_project_lock_position = 0
       OR provenance_lock_position = 0
       OR same_organization_check_position = 0
       OR live_project_lock_position > provenance_lock_position
       OR provenance_lock_position > same_organization_check_position THEN
        RAISE EXCEPTION '0054 did not lock the live project, audit UUID, then validate admin audit scope';
    END IF;
END;
$$;

DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_other_organization_id UUID := '51000000-0000-4000-8000-000000000002';
    fixture_owner_id UUID := '51000000-0000-4000-8000-000000000101';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    fixture_other_project_id UUID := '51000000-0000-4000-8000-000000000020';
    serialized_project_id UUID := '54000000-0000-4000-8000-000000000001';
    error_state TEXT;
    error_message TEXT;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id = serialized_project_id
          AND actor_id = fixture_owner_id
          AND target_actor_id = fixture_reader_id
          AND action = 'project_grant_set'
    ) THEN
        RAISE EXCEPTION '0054 advisory-lock contender did not retain its admin audit event';
    END IF;

    PERFORM audit_admin_access_event(
        fixture_organization_id,
        NULL,
        fixture_owner_id,
        fixture_owner_id,
        'bootstrap_owner_granted'
    );
    IF NOT EXISTS (
        SELECT 1
        FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id IS NULL
          AND actor_id = fixture_owner_id
          AND target_actor_id = fixture_owner_id
          AND action = 'bootstrap_owner_granted'
    ) THEN
        RAISE EXCEPTION '0054 rejected an organization-scoped admin audit event';
    END IF;

    BEGIN
        PERFORM audit_admin_access_event(
            fixture_organization_id,
            fixture_other_project_id,
            fixture_owner_id,
            fixture_reader_id,
            'project_grant_set'
        );
        RAISE EXCEPTION '0054 accepted a cross-organization project-scoped admin audit event';
    EXCEPTION WHEN foreign_key_violation THEN
        GET STACKED DIAGNOSTICS
            error_state = RETURNED_SQLSTATE,
            error_message = MESSAGE_TEXT;
        IF error_state <> '23503'
           OR error_message <> 'admin access audit project belongs to another organization' THEN
            RAISE EXCEPTION '0054 changed the admin audit cross-organization error contract';
        END IF;
    END;

    BEGIN
        UPDATE admin_access_audit_events
        SET action = 'project_grant_revoked'
        WHERE organization_id = fixture_organization_id
          AND project_id = serialized_project_id;
        RAISE EXCEPTION '0054 accepted an admin access audit update';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;
    BEGIN
        DELETE FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id = serialized_project_id;
        RAISE EXCEPTION '0054 accepted an admin access audit deletion';
    EXCEPTION WHEN object_not_in_prerequisite_state THEN
        NULL;
    END;

    UPDATE projects
    SET status = 'deleting'
    WHERE id = serialized_project_id
      AND organization_id = fixture_organization_id;
    PERFORM 1
    FROM projects
    WHERE id = serialized_project_id
      AND organization_id = fixture_organization_id
      AND status = 'deleting'
    FOR UPDATE;
    PERFORM lock_project_audit_provenance(serialized_project_id);
    PERFORM set_config('astraea.project_deletion_id', serialized_project_id::text, true);
    DELETE FROM projects WHERE id = serialized_project_id;

    IF EXISTS (SELECT 1 FROM projects WHERE id = serialized_project_id) THEN
        RAISE EXCEPTION '0054 fixture project was not retired before UUID reuse assertion';
    END IF;
    BEGIN
        INSERT INTO projects (id, organization_id, name, slug)
        VALUES (
            serialized_project_id,
            fixture_organization_id,
            'Reused 0054 Admin Audit Serialization',
            'reused-0054-admin-audit-serialization'
        );
        RAISE EXCEPTION '0054 allowed reuse of a UUID with retained admin access audit provenance';
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS
            error_state = RETURNED_SQLSTATE,
            error_message = MESSAGE_TEXT;
        IF error_state <> '23505'
           OR error_message <> 'project UUID has retained audit provenance' THEN
            RAISE EXCEPTION '0054 changed the retained admin-audit UUID reuse error contract';
        END IF;
    END;

    IF EXISTS (
        SELECT 1
        FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id = fixture_other_project_id
    ) THEN
        RAISE EXCEPTION '0054 retained a cross-organization project-scoped admin audit event';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM organizations
        WHERE id = fixture_other_organization_id
    ) THEN
        RAISE EXCEPTION '0054 fixture lost the cross-organization scope control';
    END IF;
END;
$$;
