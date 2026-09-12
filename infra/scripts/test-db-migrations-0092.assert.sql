DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass
          AND conname = 'experiment_tasks_evaluation_run_item_pair_check'
          AND pg_get_constraintdef(oid) LIKE '%(evaluation_run_id IS NULL) = (evaluation_run_item_id IS NULL)%'
    ) THEN
        RAISE EXCEPTION '0092 task Run/Run-item paired-nullability check is missing';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass
          AND conname = 'experiment_results_evaluation_run_item_pair_check'
          AND pg_get_constraintdef(oid) LIKE '%(evaluation_run_id IS NULL) = (evaluation_run_item_id IS NULL)%'
    ) THEN
        RAISE EXCEPTION '0092 result Run/Run-item paired-nullability check is missing';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE (evaluation_run_id IS NULL) <> (evaluation_run_item_id IS NULL)
    ) THEN
        RAISE EXCEPTION '0092 left a task with a half-scoped Run association';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE (evaluation_run_id IS NULL) <> (evaluation_run_item_id IS NULL)
    ) THEN
        RAISE EXCEPTION '0092 left a result with a half-scoped Run association';
    END IF;
END $$;
