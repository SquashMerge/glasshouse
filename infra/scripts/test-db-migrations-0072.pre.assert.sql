DO $$
DECLARE
    fixture_dataset_item_id UUID := '72000000-0000-4000-8000-000000000005';
    fixture_dataset_version_item_id UUID := '72000000-0000-4000-8000-000000000008';
    fixture_experiment_id UUID := '72000000-0000-4000-8000-000000000006';
    fixture_admission_id UUID := '72000000-0000-4000-8000-000000000007';
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM dataset_items
        WHERE id = fixture_dataset_item_id
          AND project_id = '72000000-0000-4000-8000-000000000002'
          AND dataset_id = '72000000-0000-4000-8000-000000000003'
    ) THEN
        RAISE EXCEPTION '0072 fixture did not create a legacy dataset item before migration';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM experiment_tasks
        JOIN dataset_version_items AS item ON item.id = experiment_tasks.dataset_version_item_id
        WHERE experiment_tasks.experiment_id = fixture_experiment_id
          AND experiment_tasks.dataset_version_item_id = fixture_dataset_version_item_id
          AND item.item_key = fixture_dataset_item_id::TEXT
          AND experiment_tasks.status = 'pending'
    ) THEN
        RAISE EXCEPTION '0072 fixture did not create a pending legacy task through the historical trigger';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM execution_admissions AS admission
        JOIN experiment_tasks AS task ON task.id = admission.work_id
        WHERE admission.id = fixture_admission_id
          AND admission.work_kind = 'experiment_task'
          AND admission.status = 'active'
          AND admission.cancelled_at IS NULL
          AND admission.completed_at IS NULL
          AND task.experiment_id = fixture_experiment_id
          AND task.dataset_version_item_id = fixture_dataset_version_item_id
    ) THEN
        RAISE EXCEPTION '0072 fixture did not create an active admission for the legacy task';
    END IF;
END
$$;
