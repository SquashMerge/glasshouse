DO $$
DECLARE
    fixture_project_id UUID := '68000000-0000-4000-8000-000000000001';
    fixture_legacy_dataset_id UUID := '68000000-0000-4000-8000-000000000002';
    fixture_deleted_dataset_id UUID := '68000000-0000-4000-8000-000000000004';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM dataset_curation_idempotency
        WHERE project_id = fixture_project_id
          AND idempotency_key = 'legacy-import-key'
          AND dataset_id = fixture_legacy_dataset_id
    ) THEN
        RAISE EXCEPTION '0068 did not backfill the legacy curation target';
    END IF;

    DELETE FROM datasets
    WHERE project_id = fixture_project_id
      AND id = fixture_deleted_dataset_id;

    IF EXISTS (
        SELECT 1
        FROM dataset_curation_idempotency
        WHERE project_id = fixture_project_id
          AND idempotency_key = 'deleted-target-key'
          AND dataset_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION '0068 retained a deleted curation target reference';
    END IF;
END
$$;
