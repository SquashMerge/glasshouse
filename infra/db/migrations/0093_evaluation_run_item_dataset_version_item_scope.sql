-- Keep a Run item, its task, and its result bound to the same immutable
-- Dataset-version item. Historical mismatches retain their result content but
-- lose the unprovable Run association rather than being guessed.
INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason
)
SELECT task.id, task.project_id, task.evaluation_run_id,
       task.evaluation_run_item_id, NULL,
       CASE
           WHEN task.dataset_version_item_id IS NULL THEN 'missing_dataset_version_item'
           ELSE 'run_item_dataset_version_item_mismatch'
       END
FROM experiment_tasks AS task
LEFT JOIN evaluation_run_items AS item
  ON item.id = task.evaluation_run_item_id
 AND item.project_id = task.project_id
 AND item.run_id = task.evaluation_run_id
 AND item.dataset_version_item_id = task.dataset_version_item_id
WHERE task.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_item_id IS NOT NULL
  AND item.id IS NULL
ON CONFLICT (task_id) DO NOTHING;

INSERT INTO agent_introspection_report_scope_quarantine (
    report_id, organization_id, project_id, evaluation_run_id, task_id,
    invocation_id, request_hash, reason
)
SELECT report.id, report.organization_id, report.project_id,
       report.evaluation_run_id, report.task_id, report.invocation_id,
       report.request_hash, 'task_run_item_dataset_version_item_mismatch'
FROM agent_introspection_reports AS report
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = report.task_id
 AND quarantine.project_id = report.project_id
 AND quarantine.evaluation_run_id = report.evaluation_run_id
WHERE quarantine.reason IN (
    'missing_dataset_version_item',
    'run_item_dataset_version_item_mismatch'
)
ON CONFLICT (report_id) DO NOTHING;

ALTER TABLE agent_introspection_reports
    DISABLE TRIGGER agent_introspection_reports_immutable;
DELETE FROM agent_introspection_reports AS report
USING experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = report.task_id
  AND quarantine.project_id = report.project_id
  AND quarantine.evaluation_run_id = report.evaluation_run_id
  AND quarantine.reason IN (
      'missing_dataset_version_item',
      'run_item_dataset_version_item_mismatch'
  );
ALTER TABLE agent_introspection_reports
    ENABLE TRIGGER agent_introspection_reports_immutable;

UPDATE experiment_results AS result
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_tasks AS task
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = task.id
WHERE quarantine.reason IN (
        'missing_dataset_version_item',
        'run_item_dataset_version_item_mismatch'
    )
  AND result.experiment_id = task.experiment_id
  AND result.project_id = task.project_id
  AND result.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
  AND (
      result.evaluation_run_id IS NOT DISTINCT FROM task.evaluation_run_id
      OR result.evaluation_run_item_id IS NOT DISTINCT FROM task.evaluation_run_item_id
  );

UPDATE experiment_tasks AS task
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.reason IN (
      'missing_dataset_version_item',
      'run_item_dataset_version_item_mismatch'
  );

UPDATE experiment_results AS result
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
WHERE evaluation_run_id IS NOT NULL
  AND evaluation_run_item_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM evaluation_run_items AS item
      WHERE item.id = result.evaluation_run_item_id
        AND item.project_id = result.project_id
        AND item.run_id = result.evaluation_run_id
        AND item.dataset_version_item_id = result.dataset_version_item_id
  );

ALTER TABLE evaluation_run_items
    DROP CONSTRAINT IF EXISTS evaluation_run_items_id_project_run_dataset_version_item_key;
ALTER TABLE evaluation_run_items
    ADD CONSTRAINT evaluation_run_items_id_project_run_dataset_version_item_key
    UNIQUE (id, project_id, run_id, dataset_version_item_id);

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_run_fkey;
ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_dataset_version_item_fkey;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_evaluation_run_item_dataset_version_item_fkey
    FOREIGN KEY (
        evaluation_run_item_id, project_id, evaluation_run_id,
        dataset_version_item_id
    ) REFERENCES evaluation_run_items(
        id, project_id, run_id, dataset_version_item_id
    ) ON DELETE RESTRICT;
ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_dataset_version_item_check;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_evaluation_run_dataset_version_item_check
    CHECK (evaluation_run_id IS NULL OR dataset_version_item_id IS NOT NULL);

ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_item_fkey;
ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_fkey;
ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_item_dataset_version_item_fkey;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_evaluation_run_item_dataset_version_item_fkey
    FOREIGN KEY (
        evaluation_run_item_id, project_id, evaluation_run_id,
        dataset_version_item_id
    ) REFERENCES evaluation_run_items(
        id, project_id, run_id, dataset_version_item_id
    ) ON DELETE RESTRICT;
ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_dataset_version_item_check;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_evaluation_run_dataset_version_item_check
    CHECK (evaluation_run_id IS NULL OR dataset_version_item_id IS NOT NULL);
