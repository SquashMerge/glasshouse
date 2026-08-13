DO $$
DECLARE
    function_definition TEXT := pg_get_functiondef('prevent_project_audit_uuid_reuse'::regproc);
    provenance_lock_position INTEGER;
BEGIN
    provenance_lock_position := strpos(
        function_definition,
        'PERFORM lock_project_audit_provenance(NEW.id);'
    );
    IF provenance_lock_position = 0
       OR provenance_lock_position > strpos(function_definition, 'FROM project_authorization_audit_events WHERE project_id = NEW.id')
       OR provenance_lock_position > strpos(function_definition, 'FROM project_lifecycle_audit_events WHERE project_id = NEW.id')
       OR provenance_lock_position > strpos(function_definition, 'FROM governance_audit_events WHERE project_id = NEW.id')
       OR provenance_lock_position > strpos(function_definition, 'FROM admin_access_audit_events WHERE project_id = NEW.id') THEN
        RAISE EXCEPTION '0053 did not serialize project UUID provenance checks before retained audit access';
    END IF;

    IF function_definition NOT LIKE '%RAISE EXCEPTION ''project UUID has retained audit provenance''%'
       OR function_definition NOT LIKE '%USING ERRCODE = ''23505''%' THEN
        RAISE EXCEPTION '0053 changed the project UUID retained-audit error contract';
    END IF;
END;
$$;

DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_owner_id UUID := '51000000-0000-4000-8000-000000000101';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    retired_project_id UUID := '53000000-0000-4000-8000-000000000001';
    error_state TEXT;
    error_message TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM projects WHERE id = retired_project_id) THEN
        RAISE EXCEPTION '0053 fixture project was not retired before UUID reuse assertion';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM admin_access_audit_events
        WHERE organization_id = fixture_organization_id
          AND project_id = retired_project_id
          AND actor_id = fixture_owner_id
          AND target_actor_id = fixture_reader_id
          AND action = 'project_grant_set'
    ) THEN
        RAISE EXCEPTION '0053 fixture has no retained admin access audit provenance';
    END IF;
    IF EXISTS (
        SELECT 1 FROM project_authorization_audit_events WHERE project_id = retired_project_id
        UNION ALL
        SELECT 1 FROM project_lifecycle_audit_events WHERE project_id = retired_project_id
        UNION ALL
        SELECT 1 FROM governance_audit_events WHERE project_id = retired_project_id
    ) THEN
        RAISE EXCEPTION '0053 fixture has non-admin audit provenance for the retired project UUID';
    END IF;

    BEGIN
        INSERT INTO projects (id, organization_id, name, slug)
        VALUES (
            retired_project_id,
            fixture_organization_id,
            'Reused Retired Admin Audit Project',
            'reused-retired-admin-audit-project'
        );
        RAISE EXCEPTION '0053 allowed reuse of a UUID with retained admin access audit provenance';
    EXCEPTION WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS
            error_state = RETURNED_SQLSTATE,
            error_message = MESSAGE_TEXT;
        IF error_state <> '23505'
           OR error_message <> 'project UUID has retained audit provenance' THEN
            RAISE EXCEPTION '0053 changed the retained admin-audit UUID reuse error contract';
        END IF;
    END;
END;
$$;
