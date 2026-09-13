WITH schema_valid_report AS (
    SELECT $$
    {
      "contract_version": "agent-introspection.v1",
      "adapter": { "name": "fixture", "version": "1", "framework": "fixture", "framework_version": "1" },
      "capabilities": [
        { "capability": "agent_lifecycle", "support": "supported", "reason": null },
        { "capability": "model_calls", "support": "supported", "reason": null },
        { "capability": "tool_calls", "support": "supported", "reason": null },
        { "capability": "workflows", "support": "supported", "reason": null },
        { "capability": "teams", "support": "supported", "reason": null },
        { "capability": "handoffs", "support": "supported", "reason": null },
        { "capability": "retries", "support": "supported", "reason": null },
        { "capability": "streaming", "support": "supported", "reason": null },
        { "capability": "trace_linkage", "support": "supported", "reason": null },
        { "capability": "content_references", "support": "supported", "reason": null },
        { "capability": "cost", "support": "supported", "reason": null }
      ],
      "capture": { "source": "client_reported", "content_mode": "references_only", "sampling": "full" },
      "outcome": "unknown",
      "completeness": "partial",
      "omissions": ["unknown"],
      "events": []
    }
    $$::jsonb AS report
), report_tasks AS (
    SELECT '90000000-0000-4000-8000-000000000016'::uuid AS id,
           '90000000-0000-4000-8000-000000000017'::uuid AS invocation_id,
           task.evaluation_run_id, task.evaluation_run_item_id, task.id AS task_id
    FROM experiment_tasks AS task
    WHERE task.experiment_id = '90000000-0000-4000-8000-000000000014'
      AND task.dataset_version_item_id = '90000000-0000-4000-8000-000000000018'
    UNION ALL
    SELECT '90000000-0000-4000-8000-000000000031'::uuid,
           '90000000-0000-4000-8000-000000000032'::uuid,
           task.evaluation_run_id, task.evaluation_run_item_id, task.id
    FROM experiment_tasks AS task
    WHERE task.experiment_id = '90000000-0000-4000-8000-000000000014'
      AND task.dataset_version_item_id = '90000000-0000-4000-8000-000000000007'
)
INSERT INTO agent_introspection_reports (
    id, organization_id, project_id, evaluation_run_id, evaluation_run_item_id,
    task_id, invocation_id, reported_by_actor_id, contract_version, source,
    outcome, completeness, request_hash, report
)
SELECT report_tasks.id,
       '90000000-0000-4000-8000-000000000001',
       '90000000-0000-4000-8000-000000000002',
       report_tasks.evaluation_run_id, report_tasks.evaluation_run_item_id,
       report_tasks.task_id, report_tasks.invocation_id,
       '90000000-0000-4000-8000-000000000003',
       'agent-introspection.v1', 'client_reported', 'unknown', 'partial',
       repeat('a', 64), schema_valid_report.report
FROM report_tasks
CROSS JOIN schema_valid_report;
