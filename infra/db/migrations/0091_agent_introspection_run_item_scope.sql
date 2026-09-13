-- P4 #166a remediation: a task's Run item must be from that same Run. Do not
-- guess an item for historical rows; preserve a deterministic repair or remove
-- the invalid association after recording only its safe identity metadata.
CREATE TABLE IF NOT EXISTS experiment_task_run_item_mismatch_quarantine (
    task_id UUID PRIMARY KEY,
    project_id UUID NOT NULL,
    evaluation_run_id UUID NOT NULL,
    evaluation_run_item_id UUID,
    remediated_evaluation_run_item_id UUID,
    reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS agent_introspection_report_scope_quarantine (
    report_id UUID PRIMARY KEY,
    organization_id UUID NOT NULL,
    project_id UUID NOT NULL,
    evaluation_run_id UUID NOT NULL,
    task_id UUID NOT NULL,
    invocation_id UUID NOT NULL,
    request_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, organization_id)
        REFERENCES projects(id, organization_id) ON DELETE RESTRICT
);

-- Record every pre-existing bad relationship before repair. A matching Run
-- item is deterministic only when it carries the task's pinned Dataset item.
INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason
)
SELECT task.id, task.project_id, task.evaluation_run_id,
       task.evaluation_run_item_id, candidate.id,
       CASE WHEN candidate.id IS NULL THEN 'no_deterministic_run_item' ELSE 'remapped_by_dataset_version_item' END
FROM experiment_tasks AS task
LEFT JOIN LATERAL (
    SELECT item.id
    FROM evaluation_run_items AS item
    WHERE item.project_id = task.project_id
      AND item.run_id = task.evaluation_run_id
      AND item.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
    ORDER BY item.id
    LIMIT 1
) AS candidate ON true
WHERE task.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_item_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM evaluation_run_items AS item
      WHERE item.id = task.evaluation_run_item_id
        AND item.project_id = task.project_id
        AND item.run_id = task.evaluation_run_id
  )
ON CONFLICT (task_id) DO NOTHING;

-- A deterministic target is still unsafe when a legacy database has multiple
-- tasks converging on it, or when an existing task already occupies it. Keep
-- that decision in this ledgered migration rather than a pre-migration helper.
WITH planned_remaps AS (
    SELECT task.id, task.project_id, task.evaluation_run_id,
           task.evaluation_run_item_id, candidate.id AS candidate_id,
           EXISTS (
               SELECT 1
               FROM experiment_tasks AS occupied_task
               WHERE occupied_task.project_id = task.project_id
                 AND occupied_task.evaluation_run_id = task.evaluation_run_id
                 AND occupied_task.evaluation_run_item_id = candidate.id
                 AND occupied_task.id <> task.id
           ) AS candidate_occupied
    FROM experiment_tasks AS task
    JOIN LATERAL (
        SELECT item.id
        FROM evaluation_run_items AS item
        WHERE item.project_id = task.project_id
          AND item.run_id = task.evaluation_run_id
          AND item.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
        ORDER BY item.id
        LIMIT 1
    ) AS candidate ON true
    WHERE task.evaluation_run_id IS NOT NULL
      AND (
          task.evaluation_run_item_id IS NULL
          OR NOT EXISTS (
              SELECT 1
              FROM evaluation_run_items AS item
              WHERE item.id = task.evaluation_run_item_id
                AND item.project_id = task.project_id
                AND item.run_id = task.evaluation_run_id
          )
      )
), conflicting_remaps AS (
    SELECT planned_remaps.*,
           count(*) OVER (PARTITION BY candidate_id) AS candidate_remap_count
    FROM planned_remaps
)
INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason
)
SELECT id, project_id, evaluation_run_id, evaluation_run_item_id, NULL,
       CASE
           WHEN candidate_occupied THEN 'deterministic_run_item_occupied'
           ELSE 'deterministic_run_item_remap_collision'
       END
FROM conflicting_remaps
WHERE candidate_occupied OR candidate_remap_count > 1
ON CONFLICT (task_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    evaluation_run_id = EXCLUDED.evaluation_run_id,
    evaluation_run_item_id = EXCLUDED.evaluation_run_item_id,
    remediated_evaluation_run_item_id = EXCLUDED.remediated_evaluation_run_item_id,
    reason = EXCLUDED.reason;

-- Quarantine report identities, never their content, before removing reports
-- whose task cannot be deterministically repaired.
INSERT INTO agent_introspection_report_scope_quarantine (
    report_id, organization_id, project_id, evaluation_run_id, task_id,
    invocation_id, request_hash, reason
)
SELECT report.id, report.organization_id, report.project_id,
       report.evaluation_run_id, report.task_id, report.invocation_id,
       report.request_hash, quarantine.reason
FROM agent_introspection_reports AS report
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = report.task_id
 AND quarantine.project_id = report.project_id
 AND quarantine.evaluation_run_id = report.evaluation_run_id
WHERE quarantine.remediated_evaluation_run_item_id IS NULL
ON CONFLICT (report_id) DO NOTHING;

CREATE OR REPLACE FUNCTION prevent_agent_introspection_report_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('astraea.agent_introspection_scope_remediation', true) = 'on' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'agent introspection reports are immutable' USING ERRCODE = '55000';
END $$;

SELECT set_config('astraea.agent_introspection_scope_remediation', 'on', false);
DELETE FROM agent_introspection_reports AS report
USING experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = report.task_id
  AND quarantine.project_id = report.project_id
  AND quarantine.evaluation_run_id = report.evaluation_run_id
  AND quarantine.remediated_evaluation_run_item_id IS NULL;

-- The original report-to-task FK contains the item ID, so it must be replaced
-- while a deterministic repair changes the parent key.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'agent_introspection_reports'::regclass
      AND confrelid = 'experiment_tasks'::regclass
      AND contype = 'f';
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE agent_introspection_reports DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

UPDATE experiment_tasks AS task
SET evaluation_run_item_id = quarantine.remediated_evaluation_run_item_id
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.remediated_evaluation_run_item_id IS NOT NULL;

UPDATE experiment_tasks AS task
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.remediated_evaluation_run_item_id IS NULL;

UPDATE agent_introspection_reports AS report
SET evaluation_run_item_id = quarantine.remediated_evaluation_run_item_id
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = report.task_id
  AND quarantine.project_id = report.project_id
  AND quarantine.evaluation_run_id = report.evaluation_run_id
  AND quarantine.remediated_evaluation_run_item_id IS NOT NULL;
SELECT set_config('astraea.agent_introspection_scope_remediation', 'off', false);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM experiment_tasks AS task
        WHERE task.evaluation_run_id IS NOT NULL
          AND task.evaluation_run_item_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM evaluation_run_items AS item
              WHERE item.id = task.evaluation_run_item_id
                AND item.project_id = task.project_id
                AND item.run_id = task.evaluation_run_id
          )
    ) THEN
        RAISE EXCEPTION 'experiment task Run-item remediation did not fail closed';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'evaluation_run_items'::regclass
          AND conname = 'evaluation_run_items_id_project_run_key'
    ) THEN
        ALTER TABLE evaluation_run_items
            ADD CONSTRAINT evaluation_run_items_id_project_run_key
            UNIQUE (id, project_id, run_id);
    END IF;
END $$;

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_fkey;
ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_run_fkey;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_evaluation_run_item_run_fkey
    FOREIGN KEY (evaluation_run_item_id, project_id, evaluation_run_id)
    REFERENCES evaluation_run_items(id, project_id, run_id) ON DELETE RESTRICT;

ALTER TABLE agent_introspection_reports
	DROP CONSTRAINT IF EXISTS agent_introspection_reports_task_scope_fkey;
ALTER TABLE agent_introspection_reports
	ADD CONSTRAINT agent_introspection_reports_task_scope_fkey
	FOREIGN KEY (task_id, project_id, evaluation_run_id, evaluation_run_item_id)
	REFERENCES experiment_tasks(id, project_id, evaluation_run_id, evaluation_run_item_id)
	ON DELETE RESTRICT;

ALTER TABLE agent_introspection_reports
    DROP CONSTRAINT IF EXISTS agent_introspection_reports_run_item_scope_fkey;
ALTER TABLE agent_introspection_reports
    ADD CONSTRAINT agent_introspection_reports_run_item_scope_fkey
    FOREIGN KEY (evaluation_run_item_id, project_id, evaluation_run_id)
    REFERENCES evaluation_run_items(id, project_id, run_id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_agent_introspection_report_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND project_deletion_is_authorized(OLD.project_id) THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'agent introspection reports are immutable' USING ERRCODE = '55000';
END $$;
