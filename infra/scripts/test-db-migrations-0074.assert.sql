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
    fixture_evaluation_id UUID := '74000000-0000-4000-8000-000000000005';
    version_id UUID := '74000000-0000-4000-8000-000000000006';
BEGIN
    IF EXISTS (
        SELECT 1
        FROM evaluation_definition_versions
        WHERE id = version_id
          AND (
              dataset_version_id IS DISTINCT FROM '74000000-0000-4000-8000-000000000004'::uuid
              OR evaluator IS DISTINCT FROM '{"kind":"exact_match"}'::jsonb
              OR target IS DISTINCT FROM '{"kind":"configured_llm"}'::jsonb
              OR execution_defaults IS DISTINCT FROM '{}'::jsonb
              OR thresholds IS DISTINCT FROM '{}'::jsonb
              OR sampling IS NOT NULL
              OR limits IS NOT NULL
              OR content_hash IS DISTINCT FROM repeat('b', 64)
          )
    ) THEN
        RAISE EXCEPTION '0075 rewrote immutable legacy-untyped definition content or hash';
    END IF;
    BEGIN
        UPDATE evaluation_definition_versions SET version = 2 WHERE id = version_id;
        RAISE EXCEPTION '0074 allowed immutable version mutation';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    INSERT INTO evaluation_audit_events (organization_id, project_id, evaluation_id, actor_id, event_type)
    VALUES ('00000000-0000-4000-8000-000000000001', fixture_project_id, fixture_evaluation_id, '74000000-0000-4000-8000-000000000001', 'created');
    BEGIN
        UPDATE evaluation_audit_events SET event_type = 'draft_updated' WHERE evaluation_id = fixture_evaluation_id;
        RAISE EXCEPTION '0075 allowed evaluation audit update';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    BEGIN
        DELETE FROM evaluation_audit_events WHERE evaluation_id = fixture_evaluation_id;
        RAISE EXCEPTION '0075 allowed evaluation audit delete';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM evaluation_legacy_links WHERE project_id = fixture_project_id AND legacy_kind = 'experiment' AND legacy_id = '74000000-0000-4000-8000-000000000008') THEN
        RAISE EXCEPTION '0074 did not preserve truthful experiment legacy links';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM evaluation_legacy_links WHERE project_id = fixture_project_id AND legacy_kind = 'benchmark_suite' AND legacy_id = '74000000-0000-4000-8000-000000000007') THEN
        RAISE EXCEPTION '0074 did not preserve truthful benchmark suite legacy links';
    END IF;
END $$;