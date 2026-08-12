DO $$
DECLARE
    test_organization_id CONSTANT UUID := '66666666-6666-4666-8666-666666666666';
    test_project_id CONSTANT UUID := '66666666-6666-4666-8666-666666666665';
    test_actor_id CONSTANT UUID := '66666666-6666-4666-8666-666666666601';
    test_dataset_id CONSTANT UUID := '66666666-6666-4666-8666-666666666620';
    historical_experiment_id CONSTANT UUID := '66666666-6666-4666-8666-666666666622';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'experiments'
          AND column_name = 'requested_by_actor_id'
    ) THEN
        RAISE EXCEPTION '0042 did not add the durable experiment requester actor';
    END IF;

    IF (SELECT status FROM experiments WHERE id = historical_experiment_id) <> 'cancelled'
       OR EXISTS (
           SELECT 1
           FROM experiment_tasks
           WHERE experiment_id = historical_experiment_id
             AND status IN ('pending', 'running')
       ) THEN
        RAISE EXCEPTION '0042 did not safely cancel historical unbound experiment work';
    END IF;

    INSERT INTO experiments (
        id,
        project_id,
        agent_id,
        dataset_id,
        name,
        config,
        requested_by_actor_id
    ) VALUES (
        '66666666-6666-4666-8666-666666666623',
        test_project_id,
        NULL,
        test_dataset_id,
        'Bound experiment',
        '{}',
        test_actor_id
    );

    IF NOT EXISTS (
        SELECT 1
        FROM experiments
        WHERE id = '66666666-6666-4666-8666-666666666623'
          AND requested_by_actor_id = test_actor_id
    ) THEN
        RAISE EXCEPTION '0042 did not retain a valid requester actor';
    END IF;

    BEGIN
        INSERT INTO experiments (
            id,
            project_id,
            agent_id,
            dataset_id,
            name,
            config,
            status
        ) VALUES (
            '66666666-6666-4666-8666-666666666624',
            test_project_id,
            NULL,
            test_dataset_id,
            'Unbound active experiment',
            '{}',
            'pending'
        );
        RAISE EXCEPTION '0042 accepted an unbound active experiment';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        INSERT INTO experiments (
            id,
            project_id,
            agent_id,
            dataset_id,
            name,
            config,
            requested_by_actor_id
        ) VALUES (
            '66666666-6666-4666-8666-666666666625',
            test_project_id,
            NULL,
            test_dataset_id,
            'Wrong requester actor',
            '{}',
            durable_actor_id('internal:evaluation-worker:v1', test_organization_id::text)
        );
        RAISE EXCEPTION '0042 accepted a non-Basic requester actor';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'experiment requester actor is not scoped to the project organization' THEN
            RAISE;
        END IF;
    END;
END
$$;
