DO $$
DECLARE
    repair_organization_id UUID := '49000000-0000-4000-8000-000000000001';
    repair_project_id UUID := '49000000-0000-4000-8000-000000000003';
    matched_job_id UUID := '49000000-0000-4000-8000-000000000006';
    archive_job_id UUID := '49000000-0000-4000-8000-000000000008';
BEGIN
    UPDATE project_memberships
    SET role = 'member'
    WHERE project_id = repair_project_id
      AND actor_subject = 'cancellation-unmapped-user';

    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE id = '49000000-0000-4000-8000-000000000007'
          AND status <> 'active'
    ) OR EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id = matched_job_id
          AND status <> 'optimizing'
    ) THEN
        RAISE EXCEPTION '0049 unmapped membership revocation cancelled another actor work';
    END IF;

    UPDATE project_memberships
    SET role = 'member'
    WHERE project_id = repair_project_id
      AND actor_subject = 'cancellation-matched-user';

    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE id = '49000000-0000-4000-8000-000000000007'
          AND status <> 'cancelled'
    ) OR NOT EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id = matched_job_id
          AND status = 'stopped'
          AND cancel_requested_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1
        FROM prompt_optimization_events
        WHERE job_id = matched_job_id
          AND status = 'stopped'
          AND detail->>'reason' = 'authorization_revoked'
    ) THEN
        RAISE EXCEPTION '0049 mapped membership revocation did not cancel matching work';
    END IF;

    INSERT INTO prompt_optimization_jobs (
        id, project_id, prompt_id, prompt_slug, source_version, target_role,
        source_messages, evaluator, examples, dataset, dataset_hash, model_config,
        budget, status, requested_by
    ) VALUES (
        archive_job_id,
        repair_project_id,
        '49000000-0000-4000-8000-000000000005',
        'cancellation-identity',
        1,
        'system',
        '[{"role":"system","content":"Summarize"}]'::jsonb,
        '{}'::jsonb,
        '[]'::jsonb,
        '{"version":1,"rubric":"cancellation","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
        repeat('b', 64),
        '{}'::jsonb,
        '{}'::jsonb,
        'optimizing',
        'cancellation-unmapped-user'
    );
    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    ) VALUES (
        '49000000-0000-4000-8000-000000000009',
        repair_organization_id,
        repair_project_id,
        '49000000-0000-4000-8000-000000000004',
        'optimization',
        archive_job_id,
        (SELECT authorization_epoch FROM projects WHERE id = repair_project_id),
        now() + interval '1 minute'
    );

    UPDATE projects
    SET status = 'archived'
    WHERE id = repair_project_id;

    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE id = '49000000-0000-4000-8000-000000000009'
          AND status <> 'cancelled'
    ) OR NOT EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id = archive_job_id
          AND status = 'stopped'
          AND cancel_requested_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1
        FROM prompt_optimization_events
        WHERE job_id = archive_job_id
          AND status = 'stopped'
          AND detail->>'reason' = 'authorization_revoked'
    ) THEN
        RAISE EXCEPTION '0049 project archive did not cancel all remaining work';
    END IF;
END
$$;
