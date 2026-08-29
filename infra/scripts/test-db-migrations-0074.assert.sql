DO $$
DECLARE
    fixture_organization_id UUID := '00000000-0000-4000-8000-000000000001';
    fixture_actor_id UUID := '74000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '74000000-0000-4000-8000-000000000002';
BEGIN
    IF EXISTS (
        SELECT 1
        FROM organization_memberships
        WHERE organization_id = fixture_organization_id
          AND actor_subject = 'durable-restore-admin'
    ) OR EXISTS (
        SELECT 1
        FROM project_memberships
        WHERE project_id = fixture_project_id
    ) THEN
        RAISE EXCEPTION '0074 fabricated a legacy membership projection';
    END IF;

    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_actor_id,
        'project_manage'
    ) THEN
        RAISE EXCEPTION '0074 fixture Admin cannot manage the archived project';
    END IF;

    UPDATE projects
    SET status = 'active'
    WHERE id = fixture_project_id;

    IF NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE id = fixture_project_id
          AND organization_id = fixture_organization_id
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION '0074 did not restore the durably managed project';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM project_memberships
        WHERE project_id = fixture_project_id
    ) THEN
        RAISE EXCEPTION '0074 restore created a legacy project membership';
    END IF;
END
$$;
