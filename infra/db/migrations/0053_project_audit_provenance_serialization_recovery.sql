CREATE OR REPLACE FUNCTION prevent_project_audit_uuid_reuse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM lock_project_audit_provenance(NEW.id);

    IF EXISTS (
        SELECT 1 FROM project_authorization_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM project_lifecycle_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM governance_audit_events WHERE project_id = NEW.id
        UNION ALL
        SELECT 1 FROM admin_access_audit_events WHERE project_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'project UUID has retained audit provenance'
            USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
END;
$$;
