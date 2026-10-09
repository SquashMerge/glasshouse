DO $$
DECLARE
    project_id UUID := '82000000-0000-4000-8000-000000000010';
    actor_id UUID := '82000000-0000-4000-8000-000000000020';
    fixture_run_id UUID := '95000000-0000-4000-8000-000000000001';
    first_charge INTEGER;
    second_charge INTEGER;
BEGIN
    INSERT INTO evaluation_runs (
        id, organization_id, project_id, evaluation_id, definition_version_id,
        dataset_version_id, requested_by_actor_id, idempotency_key,
        request_hash, resolved_inputs_hash
    ) VALUES (
        fixture_run_id, '00000000-0000-4000-8000-000000000001', project_id,
        '82000000-0000-4000-8000-000000000014',
        '82000000-0000-4000-8000-000000000001',
        '82000000-0000-4000-8000-000000000013', actor_id,
        '0095-execution-bounds', repeat('9', 64), repeat('a', 64)
    );
    PERFORM set_config('glasshouse.evaluation_run_admission_run_id', fixture_run_id::text, true);
    INSERT INTO evaluation_run_inputs (
        run_id, organization_id, project_id, target, target_version,
        target_fingerprint, evaluator, evaluator_version, evaluator_fingerprint,
        execution_defaults, thresholds, sampling, sample_identity,
        ordered_item_snapshot, resolved_inputs_hash, limits, execution_bounds
    ) VALUES (
        fixture_run_id, '00000000-0000-4000-8000-000000000001', project_id,
        '{"kind":"configured_llm","provider":"openai","model":"gpt-4o-mini"}',
        'configured_llm:v1', repeat('b', 64), '{"kind":"exact_match","version":"v1"}',
        'v1', repeat('c', 64), '{}', '{}',
        '{"strategy":"first_n","sample_size":1,"seed":0}', repeat('d', 64),
        '[]', repeat('a', 64), '{"max_cost_usd":1,"max_duration_seconds":60}',
        '{"max_active_runs_per_project":1,"max_active_runs_per_actor":1,"max_requested_sample_size":1,"max_provider_calls":1}'
    );
    INSERT INTO evaluation_run_capacity_admissions (
        run_id, organization_id, project_id, actor_id, status
    ) VALUES (
        fixture_run_id, '00000000-0000-4000-8000-000000000001', project_id, actor_id, 'active'
    );

    UPDATE evaluation_runs AS run
    SET provider_call_count = provider_call_count + 1
    FROM evaluation_run_inputs AS inputs
    WHERE run.id = fixture_run_id
      AND inputs.run_id = run.id
      AND inputs.project_id = run.project_id
      AND run.provider_call_count < (inputs.execution_bounds->>'max_provider_calls')::integer
    RETURNING run.provider_call_count INTO first_charge;
    UPDATE evaluation_runs AS run
    SET provider_call_count = provider_call_count + 1
    FROM evaluation_run_inputs AS inputs
    WHERE run.id = fixture_run_id
      AND inputs.run_id = run.id
      AND inputs.project_id = run.project_id
      AND run.provider_call_count < (inputs.execution_bounds->>'max_provider_calls')::integer
    RETURNING run.provider_call_count INTO second_charge;
    IF first_charge <> 1 OR second_charge IS NOT NULL THEN
        RAISE EXCEPTION 'provider-call charge was not atomically limited by the immutable snapshot';
    END IF;
    BEGIN
        UPDATE evaluation_run_inputs
        SET execution_bounds = '{"max_active_runs_per_project":32,"max_active_runs_per_actor":32,"max_requested_sample_size":10000,"max_provider_calls":10000}'
        WHERE evaluation_run_inputs.run_id = fixture_run_id;
        RAISE EXCEPTION 'execution bounds snapshot was mutable';
    EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
    END;
    UPDATE evaluation_runs SET status = 'cancelled' WHERE id = fixture_run_id;
    IF NOT EXISTS (
        SELECT 1 FROM evaluation_run_capacity_admissions
        WHERE evaluation_run_capacity_admissions.run_id = fixture_run_id AND status = 'released'
    ) THEN
        RAISE EXCEPTION 'terminal run did not release its capacity admission';
    END IF;
END $$;
