DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    fixture_project_id UUID := '51000000-0000-4000-8000-000000000011';
    epoch_before BIGINT;
BEGIN
    INSERT INTO execution_admissions (
        organization_id,
        project_id,
        requester_actor_id,
        work_kind,
        work_id,
        authorization_epoch,
        expires_at
    )
    SELECT
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'optimization',
        gen_random_uuid(),
        authorization_epoch,
        now() + interval '1 minute'
    FROM projects
    WHERE id = fixture_project_id
    RETURNING authorization_epoch INTO epoch_before;

    DELETE FROM project_actor_grants
    WHERE project_id = fixture_project_id
      AND organization_id = fixture_organization_id
      AND actor_id = fixture_reader_id;

    IF (SELECT authorization_epoch FROM projects WHERE id = fixture_project_id) <> epoch_before + 1 THEN
        RAISE EXCEPTION '0052 did not advance the authorization epoch after durable grant revocation';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE project_id = fixture_project_id
          AND requester_actor_id = fixture_reader_id
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION '0052 did not cancel active admissions after durable grant revocation';
    END IF;
END;
$$;
