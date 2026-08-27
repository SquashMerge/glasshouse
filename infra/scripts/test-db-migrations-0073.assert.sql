DO $$
DECLARE
    fixture_project_id UUID := '73000000-0000-4000-8000-000000000002';
    fixture_dataset_id UUID := '73000000-0000-4000-8000-000000000003';
    fixture_actor_id UUID := '73000000-0000-4000-8000-000000000001';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'datasets'
          AND column_name = 'lifecycle_revision'
          AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION '0073 did not add the non-null dataset lifecycle revision';
    END IF;

    INSERT INTO dataset_retention_holds (organization_id, project_id, dataset_id, reason, created_by)
    VALUES ('00000000-0000-4000-8000-000000000001', fixture_project_id, fixture_dataset_id, 'legal review', fixture_actor_id);

    BEGIN
        DELETE FROM datasets WHERE id = fixture_dataset_id;
        RAISE EXCEPTION '0073 allowed a held dataset to be hard deleted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'datasets'::regclass
          AND tgname = 'datasets_hard_delete_guard'
    ) THEN
        RAISE EXCEPTION '0073 did not install the hard deletion guard';
    END IF;
END
$$;
