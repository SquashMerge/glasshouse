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
