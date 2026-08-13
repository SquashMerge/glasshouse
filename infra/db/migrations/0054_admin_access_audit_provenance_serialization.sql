CREATE OR REPLACE FUNCTION enforce_admin_access_audit_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.project_id IS NOT NULL THEN
        PERFORM 1
        FROM projects AS project
        WHERE project.id = NEW.project_id
        FOR KEY SHARE;

        PERFORM lock_project_audit_provenance(NEW.project_id);

        IF NOT EXISTS (
            SELECT 1
            FROM projects AS project
            WHERE project.id = NEW.project_id
              AND project.organization_id = NEW.organization_id
            FOR KEY SHARE
        ) THEN
            RAISE EXCEPTION 'admin access audit project belongs to another organization'
                USING ERRCODE = '23503';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
