DO $$
DECLARE
    fixture_project_id UUID := '82000000-0000-4000-8000-000000000010';
    other_project_id UUID := '82000000-0000-4000-8000-000000000099';
    actor_id UUID := '82000000-0000-4000-8000-000000000020';
    dataset_id UUID := '82000000-0000-4000-8000-000000000011';
    dataset_version_id UUID := '82000000-0000-4000-8000-000000000013';
    evaluation_id UUID := '82000000-0000-4000-8000-000000000014';
    agent_id UUID := '82000000-0000-4000-8000-000000000012';
    definition_version_id UUID := '82000000-0000-4000-8000-000000000001';
    evaluation_run_id UUID := '82000000-0000-4000-8000-000000000002';
    admitted_experiment_id UUID := '82000000-0000-4000-8000-000000000003';
    unadmitted_experiment_id UUID := '82000000-0000-4000-8000-000000000004';
BEGIN
    INSERT INTO actors (id) VALUES (actor_id);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES (actor_id, '00000000-0000-4000-8000-000000000001', 'basic:v1', '0082-delete-guard');
    INSERT INTO projects (id, name, slug, organization_id)
    VALUES (fixture_project_id, '0082 Delete Guard Project', '0082-delete-guard-project', '00000000-0000-4000-8000-000000000001');
    INSERT INTO agents (id, project_id, name)
    VALUES (agent_id, fixture_project_id, '0082 Delete Guard Agent');
    INSERT INTO datasets (id, project_id, slug, name)
    VALUES (dataset_id, fixture_project_id, '0082-delete-guard-dataset', '0082 Delete Guard Dataset');
    INSERT INTO dataset_versions (id, project_id, dataset_id, version, item_count, content_hash)
    VALUES (dataset_version_id, fixture_project_id, dataset_id, 1, 0, repeat('7', 64));
    INSERT INTO evaluations (id, organization_id, project_id, slug, name, created_by)
    VALUES (evaluation_id, '00000000-0000-4000-8000-000000000001', fixture_project_id, '0082-delete-guard-evaluation', '0082 Delete Guard Evaluation', actor_id);
    INSERT INTO evaluation_definition_versions (
        id,
        evaluation_id,
        organization_id,
        project_id,
        version,
        dataset_version_id,
        evaluator,
        target,
        execution_defaults,
        thresholds,
        content_hash,
        published_by,
        published_draft_revision
    ) VALUES (
        definition_version_id,
        evaluation_id,
        '00000000-0000-4000-8000-000000000001',
        fixture_project_id,
        1,
        dataset_version_id,
        '{}',
        '{}',
        '{}',
        '{}',
        repeat('8', 64),
        actor_id,
        1
    );
    INSERT INTO evaluation_runs (
        id,
        organization_id,
        project_id,
        evaluation_id,
        definition_version_id,
        dataset_version_id,
        requested_by_actor_id,
        idempotency_key,
        request_hash,
        resolved_inputs_hash
    ) VALUES (
        evaluation_run_id,
        '00000000-0000-4000-8000-000000000001',
        fixture_project_id,
        evaluation_id,
        definition_version_id,
        dataset_version_id,
        actor_id,
        '0082-delete-guard',
        repeat('9', 64),
        repeat('a', 64)
    );
    INSERT INTO experiments (
        id,
        project_id,
        agent_id,
        dataset_id,
        status,
        config,
        requested_by_actor_id,
        evaluation_run_id
    ) VALUES (
        admitted_experiment_id,
        fixture_project_id,
        agent_id,
        dataset_id,
        'pending',
        '{}',
        actor_id,
        evaluation_run_id
    );

    IF current_setting('glasshouse.project_deletion_id', true) IS NOT NULL THEN
        RAISE EXCEPTION 'deletion context GUC was not unset for the regression';
    END IF;
    BEGIN
        DELETE FROM experiments WHERE id = admitted_experiment_id;
        RAISE EXCEPTION 'admitted experiment deletion was accepted without deletion context';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM experiments WHERE id = admitted_experiment_id) THEN
        RAISE EXCEPTION 'admitted experiment was deleted without deletion context';
    END IF;

    PERFORM set_config('glasshouse.project_deletion_id', other_project_id::text, true);
    BEGIN
        DELETE FROM experiments WHERE id = admitted_experiment_id;
        RAISE EXCEPTION 'admitted experiment deletion was accepted with mismatched deletion context';
    EXCEPTION WHEN SQLSTATE '55000' THEN
        NULL;
    END;
    IF NOT EXISTS (SELECT 1 FROM experiments WHERE id = admitted_experiment_id) THEN
        RAISE EXCEPTION 'admitted experiment was deleted with mismatched deletion context';
    END IF;

    INSERT INTO experiments (
        id,
        project_id,
        agent_id,
        dataset_id,
        status,
        config,
        requested_by_actor_id
    ) VALUES (
        unadmitted_experiment_id,
        fixture_project_id,
        agent_id,
        dataset_id,
        'pending',
        '{}',
        actor_id
    );
    DELETE FROM experiments WHERE id = unadmitted_experiment_id;
    IF EXISTS (SELECT 1 FROM experiments WHERE id = unadmitted_experiment_id) THEN
        RAISE EXCEPTION 'unadmitted experiment deletion was rejected';
    END IF;

    PERFORM set_config('glasshouse.project_deletion_id', fixture_project_id::text, true);
    DELETE FROM experiments WHERE id = admitted_experiment_id;
    IF EXISTS (SELECT 1 FROM experiments WHERE id = admitted_experiment_id) THEN
        RAISE EXCEPTION 'authorized project deletion did not remove admitted experiment';
    END IF;
END $$;
