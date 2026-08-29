DO $$
DECLARE
    fixture_project_id UUID := '78000000-0000-4000-8000-000000000002';
    uuid_slug_evaluation_id UUID := '78000000-0000-4000-8000-000000000004';
    reserved_slug_evaluation_id UUID := '78000000-0000-4000-8000-000000000005';
    fixture_actor_id UUID := '78000000-0000-4000-8000-000000000001';
BEGIN
    IF EXISTS (
        SELECT 1
        FROM evaluations
        WHERE project_id = fixture_project_id
          AND (
              slug = 'compatibility'
              OR slug ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
    ) THEN
        RAISE EXCEPTION '0078 retained an ambiguous Evaluation slug';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM evaluations
        WHERE id = uuid_slug_evaluation_id
          AND slug = 'evaluation-78000000-0000-4000-8000-000000000004-2'
    ) THEN
        RAISE EXCEPTION '0078 did not deterministically remediate the UUID-shaped slug collision';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM evaluations
        WHERE id = reserved_slug_evaluation_id
          AND slug = 'evaluation-78000000-0000-4000-8000-000000000005'
          AND tombstoned_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION '0078 did not remediate the reserved tombstoned Evaluation slug';
    END IF;

    BEGIN
        UPDATE evaluations
        SET tombstoned_at = NULL
        WHERE id = reserved_slug_evaluation_id;
        RAISE EXCEPTION '0078 left the Evaluation tombstone mutation guard disabled';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;

    BEGIN
        INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
        VALUES ('78000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', fixture_project_id, '78000000-0000-4000-8000-000000000006', 'Invalid UUID slug', fixture_actor_id);
        RAISE EXCEPTION '0078 accepted a UUID-shaped Evaluation slug after upgrade';
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
    END;

    BEGIN
        INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
        VALUES ('78000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', fixture_project_id, 'compatibility', 'Reserved Evaluation slug', fixture_actor_id);
        RAISE EXCEPTION '0078 accepted the compatibility Evaluation slug after upgrade';
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
    END;

    INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
    VALUES ('78000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', fixture_project_id, 'stable-evaluation', 'Stable Evaluation slug', fixture_actor_id);
END $$;
