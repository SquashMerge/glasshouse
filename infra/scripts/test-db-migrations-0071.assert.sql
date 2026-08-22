DO $$
DECLARE
    fixture_organization_id UUID := '00000000-0000-4000-8000-000000000001';
    fixture_project_id UUID := '11111111-1111-1111-1111-111111111111';
    fixture_user_id UUID := '71000000-0000-4000-8000-000000000001';
    fixture_reader_id UUID := '71000000-0000-4000-8000-000000000002';
BEGIN
    IF NOT authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_user_id,
        'curation_write'
    ) THEN
        RAISE EXCEPTION '0071 did not authorize Users to curate';
    END IF;

    IF authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'curation_write'
    ) THEN
        RAISE EXCEPTION '0071 allowed a compatibility Read-only actor to curate';
    END IF;

    UPDATE authorization_policy_settings
    SET strict_enforcement = true, enabled_at = now()
    WHERE organization_id = fixture_organization_id;

    IF authorization_allows_project(
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'curation_write'
    ) THEN
        RAISE EXCEPTION '0071 allowed a strict Read-only actor to curate';
    END IF;

    IF pg_get_functiondef('require_dataset_lifecycle_audit_provenance'::regproc)
        NOT LIKE '%''curation_write''%' THEN
        RAISE EXCEPTION '0071 did not apply curation authorization to lifecycle audit writes';
    END IF;
END
$$;
