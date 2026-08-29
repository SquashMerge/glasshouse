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
DO $$
DECLARE
    fixture_project_id UUID := '74000000-0000-4000-8000-000000000002';
    evaluation_id UUID := '74000000-0000-4000-8000-000000000005';
    version_id UUID := '74000000-0000-4000-8000-000000000006';
BEGIN
    INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
    VALUES (evaluation_id, '00000000-0000-4000-8000-000000000001', fixture_project_id, 'fixture-evaluation', 'Fixture evaluation', '74000000-0000-4000-8000-000000000001');
    INSERT INTO evaluation_definition_drafts (evaluation_id, organization_id, project_id, dataset_version_id, evaluator, target, execution_defaults, thresholds, updated_by)
    VALUES (evaluation_id, '00000000-0000-4000-8000-000000000001', fixture_project_id, '74000000-0000-4000-8000-000000000004', '{"kind":"exact_match"}', '{"kind":"configured_llm"}', '{}', '{}', '74000000-0000-4000-8000-000000000001');
    INSERT INTO evaluation_definition_versions (id, evaluation_id, organization_id, project_id, version, dataset_version_id, evaluator, target, execution_defaults, thresholds, content_hash, published_by, published_draft_revision)
    VALUES (version_id, evaluation_id, '00000000-0000-4000-8000-000000000001', fixture_project_id, 1, '74000000-0000-4000-8000-000000000004', '{"kind":"exact_match"}', '{"kind":"configured_llm"}', '{}', '{}', repeat('b', 64), '74000000-0000-4000-8000-000000000001', 1);
    BEGIN
        UPDATE evaluation_definition_versions SET version = 2 WHERE id = version_id;
        RAISE EXCEPTION '0074 allowed immutable version mutation';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM evaluation_legacy_links WHERE project_id = fixture_project_id AND legacy_kind = 'experiment') THEN
        RAISE EXCEPTION '0074 did not preserve truthful experiment legacy links';
    END IF;
END $$;