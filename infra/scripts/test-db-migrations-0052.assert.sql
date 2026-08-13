DO $$
DECLARE
    fixture_organization_id UUID := '51000000-0000-4000-8000-000000000001';
    fixture_owner_id UUID := '51000000-0000-4000-8000-000000000101';
    fixture_reader_id UUID := '51000000-0000-4000-8000-000000000102';
    fixture_other_id UUID := '51000000-0000-4000-8000-000000000103';
    fixture_control_id UUID := '51000000-0000-4000-8000-000000000105';
    fixture_default_project_id UUID := '51000000-0000-4000-8000-000000000010';
    fixture_project_id UUID := '51000000-0000-4000-8000-000000000011';
    fixture_other_organization_id UUID := '51000000-0000-4000-8000-000000000002';
    fixture_other_project_id UUID := '51000000-0000-4000-8000-000000000020';
    epoch_before BIGINT;
    default_epoch_before BIGINT;
    active_epoch_before BIGINT;
    other_epoch_before BIGINT;
    owner_updated_at TIMESTAMPTZ;
BEGIN
    INSERT INTO execution_admissions (
        organization_id,
        project_id,
        requester_actor_id,
        work_kind,
        work_id,
        authorization_epoch,
        expires_at
    )
    SELECT
        fixture_organization_id,
        fixture_project_id,
        fixture_reader_id,
        'optimization',
        gen_random_uuid(),
        authorization_epoch,
        now() + interval '1 minute'
    FROM projects
    WHERE id = fixture_project_id
    RETURNING authorization_epoch INTO epoch_before;

    DELETE FROM project_actor_grants
    WHERE project_id = fixture_project_id
      AND organization_id = fixture_organization_id
      AND actor_id = fixture_reader_id;

    IF (SELECT authorization_epoch FROM projects WHERE id = fixture_project_id) <> epoch_before + 1 THEN
        RAISE EXCEPTION '0052 did not advance the authorization epoch after durable grant revocation';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE project_id = fixture_project_id
          AND requester_actor_id = fixture_reader_id
          AND status = 'active'
    ) THEN
        RAISE EXCEPTION '0052 did not cancel active admissions after durable grant revocation';
    END IF;

    INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role) VALUES
        (fixture_default_project_id, fixture_organization_id, fixture_reader_id, 'read_only'),
        (fixture_project_id, fixture_organization_id, fixture_reader_id, 'read_only');

    INSERT INTO actors (id) VALUES (fixture_control_id);
    INSERT INTO actor_identities (actor_id, organization_id, provider_namespace, canonical_subject)
    VALUES (
        fixture_control_id,
        fixture_organization_id,
        'basic:v1',
        'admin-fixture-control'
    );
    INSERT INTO organization_actor_roles (organization_id, actor_id, role)
    VALUES (fixture_organization_id, fixture_control_id, 'user');
    INSERT INTO project_actor_grants (project_id, organization_id, actor_id, role)
    VALUES (fixture_default_project_id, fixture_organization_id, fixture_control_id, 'read_only');

    INSERT INTO datasets (id, project_id, name) VALUES
        ('51000000-0000-4000-8000-000000000201', fixture_default_project_id, '0052 default target dataset'),
        ('51000000-0000-4000-8000-000000000211', fixture_project_id, '0052 active target dataset');
    INSERT INTO dataset_items (id, dataset_id, input, expected_output) VALUES
        ('51000000-0000-4000-8000-000000000202', '51000000-0000-4000-8000-000000000201', '{"input":"default target"}'::jsonb, '{"output":"default target"}'::jsonb),
        ('51000000-0000-4000-8000-000000000212', '51000000-0000-4000-8000-000000000211', '{"input":"active target"}'::jsonb, '{"output":"active target"}'::jsonb);
    INSERT INTO experiments (id, project_id, dataset_id, config, status, requested_by_actor_id) VALUES
        ('51000000-0000-4000-8000-000000000203', fixture_default_project_id, '51000000-0000-4000-8000-000000000201', '{}'::jsonb, 'pending', fixture_reader_id),
        ('51000000-0000-4000-8000-000000000213', fixture_project_id, '51000000-0000-4000-8000-000000000211', '{}'::jsonb, 'running', fixture_reader_id);
    UPDATE experiment_tasks
    SET status = 'running',
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + interval '1 minute'
    WHERE experiment_id = '51000000-0000-4000-8000-000000000213';
    INSERT INTO prompts (id, project_id, name, slug) VALUES
        ('51000000-0000-4000-8000-000000000204', fixture_default_project_id, '0052 default target prompt', '0052-default-target'),
        ('51000000-0000-4000-8000-000000000214', fixture_project_id, '0052 active target prompt', '0052-active-target'),
        ('51000000-0000-4000-8000-000000000224', fixture_default_project_id, '0052 control prompt', '0052-control');
    INSERT INTO prompt_optimization_jobs (
        id, project_id, prompt_id, prompt_slug, source_version, target_role,
        source_messages, evaluator, examples, dataset, dataset_hash, model_config,
        budget, status, requested_by
    ) VALUES
        (
            '51000000-0000-4000-8000-000000000205', fixture_default_project_id,
            '51000000-0000-4000-8000-000000000204', '0052-default-target', 1, 'system',
            '[{"role":"system","content":"Summarize"}]'::jsonb, '{}'::jsonb, '[]'::jsonb,
            '{"version":1,"rubric":"default target","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
            repeat('a', 64), '{}'::jsonb, '{}'::jsonb, 'queued', 'admin-fixture-reader'
        ),
        (
            '51000000-0000-4000-8000-000000000215', fixture_project_id,
            '51000000-0000-4000-8000-000000000214', '0052-active-target', 1, 'system',
            '[{"role":"system","content":"Summarize"}]'::jsonb, '{}'::jsonb, '[]'::jsonb,
            '{"version":1,"rubric":"active target","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
            repeat('b', 64), '{}'::jsonb, '{}'::jsonb, 'optimizing', 'admin-fixture-reader'
        ),
        (
            '51000000-0000-4000-8000-000000000225', fixture_default_project_id,
            '51000000-0000-4000-8000-000000000224', '0052-control', 1, 'system',
            '[{"role":"system","content":"Summarize"}]'::jsonb, '{}'::jsonb, '[]'::jsonb,
            '{"version":1,"rubric":"control","training_examples":[{"input":"one","answer":"one"}],"validation_examples":[{"input":"two","answer":"two"}]}'::jsonb,
            repeat('c', 64), '{}'::jsonb, '{}'::jsonb, 'optimizing', 'admin-fixture-control'
        );
    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    )
    SELECT admission.id,
        fixture_organization_id,
        admission.project_id,
        fixture_reader_id,
        admission.work_kind,
        admission.work_id,
        project.authorization_epoch,
        now() + interval '1 minute'
    FROM (
        VALUES
            ('51000000-0000-4000-8000-000000000206'::uuid, fixture_default_project_id, 'optimization', '51000000-0000-4000-8000-000000000205'::uuid),
            ('51000000-0000-4000-8000-000000000207'::uuid, fixture_default_project_id, 'experiment_task', (SELECT id FROM experiment_tasks WHERE experiment_id = '51000000-0000-4000-8000-000000000203')),
            ('51000000-0000-4000-8000-000000000216'::uuid, fixture_project_id, 'optimization', '51000000-0000-4000-8000-000000000215'::uuid),
            ('51000000-0000-4000-8000-000000000217'::uuid, fixture_project_id, 'experiment_task', (SELECT id FROM experiment_tasks WHERE experiment_id = '51000000-0000-4000-8000-000000000213'))
    ) AS admission(id, project_id, work_kind, work_id)
    JOIN projects AS project ON project.id = admission.project_id;
    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    )
    SELECT
        '51000000-0000-4000-8000-000000000226',
        fixture_organization_id,
        fixture_default_project_id,
        fixture_control_id,
        'optimization',
        '51000000-0000-4000-8000-000000000225',
        authorization_epoch,
        now() + interval '1 minute'
    FROM projects
    WHERE id = fixture_default_project_id;
    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    )
    SELECT
        '51000000-0000-4000-8000-000000000236',
        fixture_other_organization_id,
        fixture_other_project_id,
        fixture_other_id,
        'optimization',
        '51000000-0000-4000-8000-000000000237',
        authorization_epoch,
        now() + interval '1 minute'
    FROM projects
    WHERE id = fixture_other_project_id;

    IF NOT EXISTS (
        SELECT 1
        FROM organization_actor_roles
        WHERE organization_id = fixture_organization_id
          AND actor_id = fixture_reader_id
          AND role = 'user'
    ) OR (
        SELECT count(*)
        FROM project_actor_grants
        WHERE organization_id = fixture_organization_id
          AND actor_id = fixture_reader_id
          AND project_id IN (fixture_default_project_id, fixture_project_id)
          AND role = 'read_only'
    ) <> 2 THEN
        RAISE EXCEPTION '0052 fixture did not create a two-project durable role revocation target';
    END IF;

    SELECT authorization_epoch INTO default_epoch_before
    FROM projects
    WHERE id = fixture_default_project_id;
    SELECT authorization_epoch INTO active_epoch_before
    FROM projects
    WHERE id = fixture_project_id;
    SELECT authorization_epoch INTO other_epoch_before
    FROM projects
    WHERE id = fixture_other_project_id;
    SELECT updated_at INTO owner_updated_at
    FROM organization_actor_roles
    WHERE organization_id = fixture_organization_id
      AND actor_id = fixture_owner_id
      AND role = 'admin';

    DELETE FROM organization_actor_roles
    WHERE organization_id = fixture_organization_id
      AND actor_id = fixture_reader_id;

    IF EXISTS (
        SELECT 1
        FROM organization_actor_roles
        WHERE organization_id = fixture_organization_id
          AND actor_id = fixture_reader_id
    ) THEN
        RAISE EXCEPTION '0052 durable organization role revocation retained the target role';
    END IF;
    IF (SELECT authorization_epoch FROM projects WHERE id = fixture_default_project_id) <> default_epoch_before + 1
       OR (SELECT authorization_epoch FROM projects WHERE id = fixture_project_id) <> active_epoch_before + 1 THEN
        RAISE EXCEPTION '0052 durable organization role revocation did not advance each target project epoch exactly once';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE id IN (
            '51000000-0000-4000-8000-000000000206',
            '51000000-0000-4000-8000-000000000207',
            '51000000-0000-4000-8000-000000000216',
            '51000000-0000-4000-8000-000000000217'
        )
          AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION '0052 durable organization role revocation did not cancel target admissions across projects';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiments
        WHERE id IN (
            '51000000-0000-4000-8000-000000000203',
            '51000000-0000-4000-8000-000000000213'
        )
          AND status <> 'cancelled'
    ) OR EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id IN (
            '51000000-0000-4000-8000-000000000203',
            '51000000-0000-4000-8000-000000000213'
        )
          AND status <> 'cancelled'
    ) OR EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE experiment_id = '51000000-0000-4000-8000-000000000213'
          AND (lease_token IS NOT NULL OR lease_expires_at IS NOT NULL)
    ) THEN
        RAISE EXCEPTION '0052 durable organization role revocation did not cancel target experiment work across projects';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id IN (
            '51000000-0000-4000-8000-000000000205',
            '51000000-0000-4000-8000-000000000215'
        )
          AND (status <> 'stopped' OR cancel_requested_at IS NULL OR completed_at IS NULL)
    ) OR (
        SELECT count(*)
        FROM prompt_optimization_events
        WHERE job_id IN (
            '51000000-0000-4000-8000-000000000205',
            '51000000-0000-4000-8000-000000000215'
        )
          AND status = 'stopped'
          AND detail->>'reason' = 'authorization_revoked'
    ) <> 2 THEN
        RAISE EXCEPTION '0052 durable organization role revocation did not cancel target optimization work across projects';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM organization_actor_roles
        WHERE organization_id = fixture_organization_id
          AND actor_id = fixture_owner_id
          AND role = 'admin'
          AND updated_at = owner_updated_at
    ) OR (
        SELECT count(*)
        FROM organization_actor_roles
        WHERE organization_id = fixture_organization_id
          AND role = 'admin'
    ) <> 1 THEN
        RAISE EXCEPTION '0052 durable organization role revocation modified the final Admin';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM execution_admissions
        WHERE id = '51000000-0000-4000-8000-000000000226'
          AND status = 'active'
    ) OR NOT EXISTS (
        SELECT 1
        FROM prompt_optimization_jobs
        WHERE id = '51000000-0000-4000-8000-000000000225'
          AND status = 'optimizing'
    ) THEN
        RAISE EXCEPTION '0052 durable organization role revocation cancelled control actor work';
    END IF;
    IF (SELECT authorization_epoch FROM projects WHERE id = fixture_other_project_id) <> other_epoch_before
       OR NOT EXISTS (
           SELECT 1
           FROM execution_admissions
           WHERE id = '51000000-0000-4000-8000-000000000236'
             AND status = 'active'
       ) THEN
        RAISE EXCEPTION '0052 durable organization role revocation crossed organization scope';
    END IF;
END;
$$;
