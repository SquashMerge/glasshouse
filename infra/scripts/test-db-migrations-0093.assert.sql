DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'evaluation_run_items'::regclass
          AND conname = 'evaluation_run_items_id_project_run_dataset_version_item_key'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_tasks'::regclass
          AND conname = 'experiment_tasks_evaluation_run_item_dataset_version_item_fkey'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'experiment_results'::regclass
          AND conname = 'experiment_results_evaluation_run_item_dataset_version_item_fkey'
    ) THEN
        RAISE EXCEPTION '0093 Run-item Dataset-version-item composite scope constraints are missing';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks
        WHERE evaluation_run_id IS NOT NULL
          AND dataset_version_item_id IS NULL
    ) OR EXISTS (
        SELECT 1
        FROM experiment_results
        WHERE evaluation_run_id IS NOT NULL
          AND dataset_version_item_id IS NULL
    ) THEN
        RAISE EXCEPTION '0093 retained a Run association without a Dataset-version item';
    END IF;
END $$;
