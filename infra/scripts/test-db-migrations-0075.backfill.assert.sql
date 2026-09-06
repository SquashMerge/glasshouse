DO $$
DECLARE
    fixture_organization_id UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '74000000-0000-4000-8000-000000000002';
BEGIN
    IF (
        SELECT count(*)
        FROM evaluation_legacy_links
        WHERE organization_id = fixture_organization_id
          AND project_id = fixture_project_id
          AND (legacy_kind, legacy_id, dataset_id, created_at) IN (
              SELECT 'experiment', id, dataset_id, created_at
              FROM experiments
              WHERE id = '74000000-0000-4000-8000-000000000008'
              UNION ALL
              SELECT 'benchmark_suite', id, dataset_id, created_at
              FROM benchmark_suites
              WHERE id = '74000000-0000-4000-8000-000000000007'
          )
    ) <> 2 THEN
        RAISE EXCEPTION '0075 did not backfill both legacy_ad_hoc structural evaluation links';
    END IF;
END $$;
