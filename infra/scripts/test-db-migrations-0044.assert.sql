DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'projects'
          AND column_name = 'authorization_epoch'
    ) THEN
        RAISE EXCEPTION '0044 did not add the project authorization epoch';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class
        WHERE relname = 'execution_admissions'
          AND relkind = 'r'
    ) THEN
        RAISE EXCEPTION '0044 did not create execution admissions';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'execution_admissions_project_scope_fkey'
          AND conrelid = 'execution_admissions'::regclass
    ) THEN
        RAISE EXCEPTION '0044 did not scope execution admissions to projects';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE indexname = 'execution_admissions_active_project_requester_idx'
          AND tablename = 'execution_admissions'
    ) THEN
        RAISE EXCEPTION '0044 did not index active execution admissions';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'project_execution_admission_archive_fence'
          AND tgrelid = 'projects'::regclass
    ) THEN
        RAISE EXCEPTION '0044 did not cancel admissions for archived projects';
    END IF;
END
$$;

DO $$
DECLARE
    replay_organization_id UUID := '44000000-0000-4000-8000-000000000001';
    replay_project_id UUID := '44000000-0000-4000-8000-000000000002';
    replay_actor_id UUID := '44000000-0000-4000-8000-000000000003';
    replay_experiment_id UUID := '44000000-0000-4000-8000-000000000006';
    replay_job_id UUID := '44000000-0000-4000-8000-000000000008';
    initial_epoch BIGINT;
    demoted_epoch BIGINT;
BEGIN
    SELECT authorization_epoch INTO initial_epoch
    FROM projects
    WHERE id = replay_project_id;

    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    ) VALUES (
        '44000000-0000-4000-8000-000000000009',
        replay_organization_id,
        replay_project_id,
        replay_actor_id,
        'experiment_task',
        (SELECT id FROM experiment_tasks WHERE experiment_id = replay_experiment_id),
        initial_epoch,
        now() + interval '1 minute'
    );
    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    ) VALUES (
        '44000000-0000-4000-8000-000000000010',
        replay_organization_id,
        replay_project_id,
        replay_actor_id,
        'optimization',
        replay_job_id,
        initial_epoch,
        now() + interval '1 minute'
    );

    UPDATE project_memberships
    SET role = 'member'
    WHERE project_id = replay_project_id
      AND actor_subject = 'admission-replay-user';

    SELECT authorization_epoch INTO demoted_epoch
    FROM projects
    WHERE id = replay_project_id;
    IF demoted_epoch <> initial_epoch + 1 THEN
        RAISE EXCEPTION '0044 demotion did not increment the project authorization epoch';
    END IF;
    IF EXISTS (
        SELECT 1 FROM execution_admissions
        WHERE id IN (
            '44000000-0000-4000-8000-000000000009',
            '44000000-0000-4000-8000-000000000010'
        )
          AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION '0044 demotion left an active execution admission';
    END IF;
    IF EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE experiment_id = replay_experiment_id
          AND status <> 'cancelled'
    ) OR EXISTS (
        SELECT 1 FROM experiments
        WHERE id = replay_experiment_id
          AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION '0044 demotion did not cancel matching experiment work';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM prompt_optimization_jobs
        WHERE id = replay_job_id
          AND status = 'stopped'
          AND cancel_requested_at IS NOT NULL
    ) OR NOT EXISTS (
        SELECT 1 FROM prompt_optimization_events
        WHERE job_id = replay_job_id
          AND status = 'stopped'
          AND detail->>'reason' = 'authorization_revoked'
    ) THEN
        RAISE EXCEPTION '0044 demotion did not cancel matching optimization work';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM execution_admissions AS admission
        JOIN projects AS project ON project.id = admission.project_id
        WHERE admission.id = '44000000-0000-4000-8000-000000000009'
          AND admission.status = 'active'
          AND admission.authorization_epoch = project.authorization_epoch
          AND project.status = 'active'
    ) THEN
        RAISE EXCEPTION '0044 accepted an admission from the demoted epoch';
    END IF;

    INSERT INTO execution_admissions (
        id, organization_id, project_id, requester_actor_id, work_kind, work_id,
        authorization_epoch, expires_at
    ) VALUES (
        '44000000-0000-4000-8000-000000000011',
        replay_organization_id,
        replay_project_id,
        replay_actor_id,
        'optimization',
        replay_job_id,
        demoted_epoch,
        now() + interval '1 minute'
    );
    UPDATE projects
    SET status = 'archived'
    WHERE id = replay_project_id;

    IF EXISTS (
        SELECT 1 FROM execution_admissions
        WHERE id = '44000000-0000-4000-8000-000000000011'
          AND status <> 'cancelled'
    ) THEN
        RAISE EXCEPTION '0044 archive left an active execution admission';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM execution_admissions AS admission
        JOIN projects AS project ON project.id = admission.project_id
        WHERE admission.id = '44000000-0000-4000-8000-000000000011'
          AND admission.status = 'active'
          AND admission.authorization_epoch = project.authorization_epoch
          AND project.status = 'active'
    ) THEN
        RAISE EXCEPTION '0044 accepted an admission after archive invalidated its epoch';
    END IF;
END
$$;
