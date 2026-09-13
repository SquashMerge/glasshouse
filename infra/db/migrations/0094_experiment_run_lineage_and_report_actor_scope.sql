-- A task or result can only claim an Evaluation Run owned by its Experiment.
-- Historical conflicts retain result payloads but lose unprovable Run lineage.
CREATE TABLE IF NOT EXISTS experiment_result_run_scope_quarantine (
    result_id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    experiment_id UUID NOT NULL,
    evaluation_run_id UUID NOT NULL,
    evaluation_run_item_id UUID NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason
)
SELECT task.id, task.project_id, task.evaluation_run_id,
       task.evaluation_run_item_id, NULL, 'experiment_evaluation_run_mismatch'
FROM experiment_tasks AS task
JOIN experiments AS experiment
  ON experiment.id = task.experiment_id
 AND experiment.project_id = task.project_id
WHERE task.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_id IS DISTINCT FROM experiment.evaluation_run_id
ON CONFLICT (task_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    evaluation_run_id = EXCLUDED.evaluation_run_id,
    evaluation_run_item_id = EXCLUDED.evaluation_run_item_id,
    remediated_evaluation_run_item_id = EXCLUDED.remediated_evaluation_run_item_id,
    reason = EXCLUDED.reason;

INSERT INTO agent_introspection_report_scope_quarantine (
    report_id, organization_id, project_id, evaluation_run_id, task_id,
    invocation_id, request_hash, reason
)
SELECT report.id, report.organization_id, report.project_id,
       report.evaluation_run_id, report.task_id, report.invocation_id,
       report.request_hash, 'task_experiment_evaluation_run_mismatch'
FROM agent_introspection_reports AS report
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = report.task_id
 AND quarantine.project_id = report.project_id
 AND quarantine.evaluation_run_id = report.evaluation_run_id
WHERE quarantine.reason = 'experiment_evaluation_run_mismatch'
ON CONFLICT (report_id) DO NOTHING;

ALTER TABLE agent_introspection_reports
    DISABLE TRIGGER agent_introspection_reports_immutable;
DELETE FROM agent_introspection_reports AS report
USING experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = report.task_id
  AND quarantine.project_id = report.project_id
  AND quarantine.evaluation_run_id = report.evaluation_run_id
  AND quarantine.reason = 'experiment_evaluation_run_mismatch';
ALTER TABLE agent_introspection_reports
    ENABLE TRIGGER agent_introspection_reports_immutable;

INSERT INTO experiment_result_run_scope_quarantine (
    result_id, project_id, experiment_id, evaluation_run_id,
    evaluation_run_item_id, reason
)
SELECT result.id, result.project_id, result.experiment_id,
       result.evaluation_run_id, result.evaluation_run_item_id,
       'experiment_evaluation_run_mismatch'
FROM experiment_results AS result
JOIN experiments AS experiment
  ON experiment.id = result.experiment_id
 AND experiment.project_id = result.project_id
WHERE result.evaluation_run_id IS NOT NULL
  AND result.evaluation_run_id IS DISTINCT FROM experiment.evaluation_run_id
ON CONFLICT (result_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    experiment_id = EXCLUDED.experiment_id,
    evaluation_run_id = EXCLUDED.evaluation_run_id,
    evaluation_run_item_id = EXCLUDED.evaluation_run_item_id,
    reason = EXCLUDED.reason;

UPDATE experiment_tasks AS task
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.reason = 'experiment_evaluation_run_mismatch';

UPDATE experiment_results AS result
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_result_run_scope_quarantine AS quarantine
WHERE quarantine.result_id = result.id;

CREATE UNIQUE INDEX IF NOT EXISTS experiments_id_project_evaluation_run_id_key
    ON experiments(id, project_id, evaluation_run_id);

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_experiment_run_lineage_fkey;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_experiment_run_lineage_fkey
    FOREIGN KEY (experiment_id, project_id, evaluation_run_id)
    REFERENCES experiments(id, project_id, evaluation_run_id) ON DELETE RESTRICT;

ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_experiment_run_lineage_fkey;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_experiment_run_lineage_fkey
    FOREIGN KEY (experiment_id, project_id, evaluation_run_id)
    REFERENCES experiments(id, project_id, evaluation_run_id) ON DELETE RESTRICT;

-- A composite FK both persists actor organization provenance and closes the
-- trigger check/insert race that could previously admit a cross-org actor.
INSERT INTO agent_introspection_report_scope_quarantine (
    report_id, organization_id, project_id, evaluation_run_id, task_id,
    invocation_id, request_hash, reason
)
SELECT report.id, report.organization_id, report.project_id,
       report.evaluation_run_id, report.task_id, report.invocation_id,
       report.request_hash, 'reported_actor_organization_mismatch'
FROM agent_introspection_reports AS report
WHERE NOT EXISTS (
    SELECT 1
    FROM actor_identities AS identity
    WHERE identity.organization_id = report.organization_id
      AND identity.actor_id = report.reported_by_actor_id
)
ON CONFLICT (report_id) DO NOTHING;

ALTER TABLE agent_introspection_reports
    DISABLE TRIGGER agent_introspection_reports_immutable;
DELETE FROM agent_introspection_reports AS report
WHERE NOT EXISTS (
    SELECT 1
    FROM actor_identities AS identity
    WHERE identity.organization_id = report.organization_id
      AND identity.actor_id = report.reported_by_actor_id
);
ALTER TABLE agent_introspection_reports
    ENABLE TRIGGER agent_introspection_reports_immutable;

CREATE UNIQUE INDEX IF NOT EXISTS actor_identities_organization_id_actor_id_key
    ON actor_identities(organization_id, actor_id);
DROP TRIGGER IF EXISTS agent_introspection_reports_actor_scope
    ON agent_introspection_reports;
ALTER TABLE agent_introspection_reports
    DROP CONSTRAINT IF EXISTS agent_introspection_reports_actor_scope_fkey;
ALTER TABLE agent_introspection_reports
    ADD CONSTRAINT agent_introspection_reports_actor_scope_fkey
    FOREIGN KEY (organization_id, reported_by_actor_id)
    REFERENCES actor_identities(organization_id, actor_id) ON DELETE RESTRICT;
