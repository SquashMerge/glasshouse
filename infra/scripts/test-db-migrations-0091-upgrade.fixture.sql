INSERT INTO agent_introspection_reports (
    id, organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
    task_id, invocation_id, reported_by_actor_id, contract_version, source,
    outcome, completeness, request_hash, report
)
SELECT '90000000-0000-4000-8000-000000000016',
       '90000000-0000-4000-8000-000000000001',
       '90000000-0000-4000-8000-000000000002',
       task.evaluation_run_id, task.evaluation_run_item_id, task.id,
       '90000000-0000-4000-8000-000000000017',
       '90000000-0000-4000-8000-000000000003',
       'agent-introspection.v1', 'client_reported', 'unknown', 'partial',
       repeat('a', 64), '{}'::jsonb
FROM experiment_tasks AS task
WHERE task.experiment_id = '90000000-0000-4000-8000-000000000014'
  AND task.dataset_version_item_id = '90000000-0000-4000-8000-000000000021';
