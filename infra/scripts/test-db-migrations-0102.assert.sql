DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'experiments'::regclass AND tgname = 'experiments_requester_actor_scope' AND tgenabled = 'O')
        OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'evaluation_runs'::regclass AND tgname = 'evaluation_runs_requester_actor_scope' AND tgenabled = 'O') THEN
        RAISE EXCEPTION 'human execution requester scope guards must remain enabled';
    END IF;
    IF pg_get_functiondef('enforce_experiment_requester_actor_scope()'::regprocedure) NOT LIKE '%local:v1%'
        OR pg_get_functiondef('enforce_evaluation_run_requester_actor_scope()'::regprocedure) NOT LIKE '%local:v1%' THEN
        RAISE EXCEPTION 'execution scope must recognize local human actors';
    END IF;
END;
$$;
