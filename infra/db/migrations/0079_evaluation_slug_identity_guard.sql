-- Canonical Evaluation slugs cannot be mistaken for UUID detail IDs or static routes.
DO $$
DECLARE
    evaluation_record RECORD;
    candidate_slug TEXT;
    collision INTEGER;
    tombstone_trigger_disabled BOOLEAN := false;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM evaluations
        WHERE tombstoned_at IS NOT NULL
          AND (
              slug = 'compatibility'
              OR slug ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
    ) THEN
        EXECUTE 'ALTER TABLE evaluations DISABLE TRIGGER evaluations_tombstone_immutable';
        tombstone_trigger_disabled := true;
    END IF;

    BEGIN
        FOR evaluation_record IN
            SELECT id, project_id
            FROM evaluations
            WHERE slug = 'compatibility'
               OR slug ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            ORDER BY project_id, id
        LOOP
            candidate_slug := 'evaluation-' || evaluation_record.id::text;
            collision := 2;
            WHILE EXISTS (
                SELECT 1
                FROM evaluations
                WHERE project_id = evaluation_record.project_id
                  AND slug = candidate_slug
                  AND id <> evaluation_record.id
            ) LOOP
                candidate_slug := left(
                    'evaluation-' || evaluation_record.id::text,
                    63 - length(collision::text)
                ) || '-' || collision::text;
                collision := collision + 1;
            END LOOP;
            UPDATE evaluations
            SET slug = candidate_slug
            WHERE id = evaluation_record.id;
        END LOOP;
    EXCEPTION WHEN OTHERS THEN
        IF tombstone_trigger_disabled THEN
            EXECUTE 'ALTER TABLE evaluations ENABLE TRIGGER evaluations_tombstone_immutable';
        END IF;
        RAISE;
    END;

    IF tombstone_trigger_disabled THEN
        EXECUTE 'ALTER TABLE evaluations ENABLE TRIGGER evaluations_tombstone_immutable';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'evaluations'::regclass
          AND conname = 'evaluations_slug_identity_check'
    ) THEN
        ALTER TABLE evaluations
            ADD CONSTRAINT evaluations_slug_identity_check CHECK (
                slug <> 'compatibility'
                AND slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            );
    END IF;
END $$;
