DO $$
DECLARE
    task_item UUID;
    result_item UUID;
BEGIN
    SELECT evaluation_run_item_id INTO task_item
    FROM experiment_tasks
    WHERE experiment_id = '90000000-0000-4000-8000-000000000014';
    SELECT evaluation_run_item_id INTO result_item
    FROM experiment_results
    WHERE id = '90000000-0000-4000-8000-000000000015';
    IF task_item <> '90000000-0000-4000-8000-000000000012'
       OR result_item <> task_item THEN
        RAISE EXCEPTION 'upgrade did not atomically preserve the repaired task/result evidence';
    END IF;
    IF EXISTS (
        SELECT 1 FROM experiment_tasks
        WHERE (evaluation_run_id IS NULL) <> (evaluation_run_item_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'upgrade left a half-scoped task';
    END IF;
    IF to_regclass('public.agent_introspection_reports') IS NOT NULL
       AND EXISTS (
           SELECT 1
           FROM agent_introspection_reports
           WHERE id = '90000000-0000-4000-8000-000000000016'
             AND evaluation_run_item_id <> task_item
       ) THEN
        RAISE EXCEPTION 'upgrade did not preserve the repaired report relationship';
    END IF;
END $$;

DO $$
BEGIN
    BEGIN
        UPDATE experiment_tasks
        SET evaluation_run_item_id = NULL
        WHERE experiment_id = '90000000-0000-4000-8000-000000000014';
        RAISE EXCEPTION '0092 task pair check accepted a half-scoped task';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
        UPDATE experiment_tasks
        SET evaluation_run_item_id = '90000000-0000-4000-8000-000000000013'
        WHERE experiment_id = '90000000-0000-4000-8000-000000000014';
        RAISE EXCEPTION 'task Run-item scope FK accepted another Run item';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    IF EXISTS (
        SELECT 1 FROM agent_introspection_reports
        WHERE id = '90000000-0000-4000-8000-000000000016'
    ) THEN
        BEGIN
            UPDATE agent_introspection_reports
            SET request_hash = repeat('b', 64)
            WHERE id = '90000000-0000-4000-8000-000000000016';
            RAISE EXCEPTION 'immutable report accepted an update';
        EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
        END;
        BEGIN
            INSERT INTO agent_introspection_reports (
                organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
                task_id, invocation_id, reported_by_actor_id, contract_version, source,
                outcome, completeness, request_hash, report
            )
            SELECT organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
                   task_id, invocation_id, reported_by_actor_id, contract_version, source,
                   outcome, completeness, request_hash, report
            FROM agent_introspection_reports
            WHERE id = '90000000-0000-4000-8000-000000000016';
            RAISE EXCEPTION 'report invocation identity accepted a duplicate';
        EXCEPTION WHEN unique_violation THEN NULL;
        END;
    END IF;
END $$;
