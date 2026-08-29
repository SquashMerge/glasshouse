DO $$
DECLARE
    fixture_evaluation_id UUID := '77000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgrelid = 'evaluations'::regclass
          AND tgname = 'evaluations_tombstone_immutable'
    ) THEN
        RAISE EXCEPTION '0077 did not install the evaluation tombstone immutability guard';
    END IF;

    INSERT INTO evaluations (
        id,
        organization_id,
        project_id,
        slug,
        name,
        created_by,
        archived_at,
        tombstoned_at
    ) VALUES (
        fixture_evaluation_id,
        '00000000-0000-4000-8000-000000000001',
        fixture_project_id,
        'tombstoned-evaluation',
        'Tombstoned Evaluation',
        durable_actor_id('basic:v1', 'bootstrap-owner'),
        now(),
        now()
    );

    BEGIN
        UPDATE evaluations
        SET tombstoned_at = NULL
        WHERE id = fixture_evaluation_id;
        RAISE EXCEPTION '0077 allowed an evaluation tombstone to be cleared';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;

    IF NOT EXISTS (
        SELECT 1
        FROM evaluations
        WHERE id = fixture_evaluation_id
          AND tombstoned_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION '0077 did not retain the evaluation tombstone';
    END IF;

    PERFORM set_config(
        'astraea.project_deletion_id',
        fixture_project_id::text,
        true
    );
    DELETE FROM evaluations WHERE id = fixture_evaluation_id;
    IF EXISTS (SELECT 1 FROM evaluations WHERE id = fixture_evaluation_id) THEN
        RAISE EXCEPTION '0077 blocked authorized project deletion of an evaluation tombstone';
    END IF;
END
$$;
