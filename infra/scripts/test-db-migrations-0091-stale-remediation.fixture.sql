-- A post-0091 quarantine record can describe an earlier unoccupied target.
-- Its timestamp is audit provenance, while the remediation fields are stale.
INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason, quarantined_at
)
SELECT task.id, task.project_id, task.evaluation_run_id,
       '91000000-0000-4000-8000-000000000011',
       '91000000-0000-4000-8000-000000000011',
       'remapped_by_dataset_version_item', '2026-01-01T00:00:00Z'
FROM experiment_tasks AS task
WHERE task.experiment_id = '91000000-0000-4000-8000-000000000013'
  AND task.dataset_version_item_id = '91000000-0000-4000-8000-000000000007';
