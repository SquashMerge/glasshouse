DO $$
DECLARE
    fixture_project_id UUID := '11111111-1111-1111-1111-111111111111';
    fixture_actor_id UUID := durable_actor_id('basic:v1', 'bootstrap-owner');
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'evaluations'::regclass
          AND conname = 'evaluations_slug_identity_check'
          AND convalidated
    ) THEN
        RAISE EXCEPTION '0078 did not install a validated Evaluation slug identity guard';
    END IF;

    BEGIN
        INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
        VALUES ('78100000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', fixture_project_id, '78100000-0000-4000-8000-000000000001', 'Invalid UUID slug', fixture_actor_id);
        RAISE EXCEPTION '0078 accepted a UUID-shaped Evaluation slug';
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
    END;

    BEGIN
        INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
        VALUES ('78100000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', fixture_project_id, 'compatibility', 'Reserved Evaluation slug', fixture_actor_id);
        RAISE EXCEPTION '0078 accepted the compatibility Evaluation slug';
    EXCEPTION WHEN SQLSTATE '23514' THEN NULL;
    END;

    INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
    VALUES ('78100000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', fixture_project_id, 'stable-evaluation', 'Stable Evaluation slug', fixture_actor_id);
END $$;
