DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_owner_id UUID := '51000000-0000-4000-8000-000000000101';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    retired_project_id UUID := '53000000-0000-4000-8000-000000000001';
BEGIN
    INSERT INTO projects (id, organization_id, name, slug)
    VALUES (
        retired_project_id,
        fixture_organization_id,
        'Retired Admin Audit Project',
        'retired-admin-audit-project'
    );
    PERFORM audit_admin_access_event(
        fixture_organization_id,
        retired_project_id,
        fixture_owner_id,
        fixture_reader_id,
        'project_grant_set'
    );

    UPDATE projects
    SET status = 'deleting'
    WHERE id = retired_project_id
      AND organization_id = fixture_organization_id;
    PERFORM 1
    FROM projects
    WHERE id = retired_project_id
      AND organization_id = fixture_organization_id
      AND status = 'deleting'
    FOR UPDATE;
    PERFORM lock_project_audit_provenance(retired_project_id);
    PERFORM set_config('glasshouse.project_deletion_id', retired_project_id::text, true);
    DELETE FROM projects WHERE id = retired_project_id;

    IF EXISTS (SELECT 1 FROM projects WHERE id = retired_project_id) THEN
        RAISE EXCEPTION '0053 fixture did not retire the admin-audited project';
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
        RAISE EXCEPTION '0053 fixture did not retain the admin access audit provenance';
    END IF;
END;
$$;
