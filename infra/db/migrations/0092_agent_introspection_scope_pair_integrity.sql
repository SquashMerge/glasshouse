-- Repair scope states that 0091 could not represent with MATCH SIMPLE FKs.
-- A Run association is meaningful only when its Run item is present too.
ALTER TABLE experiment_task_run_item_mismatch_quarantine
    ALTER COLUMN evaluation_run_id DROP NOT NULL,
    ALTER COLUMN evaluation_run_item_id DROP NOT NULL;

INSERT INTO experiment_task_run_item_mismatch_quarantine (
    task_id, project_id, evaluation_run_id, evaluation_run_item_id,
    remediated_evaluation_run_item_id, reason
)
SELECT task.id, task.project_id, task.evaluation_run_id,
       task.evaluation_run_item_id,
       CASE
           WHEN candidate.id IS NOT NULL AND NOT candidate.occupied THEN candidate.id
           ELSE NULL
       END,
       CASE
           WHEN task.evaluation_run_id IS NULL THEN 'missing_evaluation_run_id'
           WHEN candidate.id IS NULL THEN 'no_deterministic_run_item'
           WHEN candidate.occupied THEN 'deterministic_run_item_occupied'
           ELSE 'remapped_by_dataset_version_item'
       END
FROM experiment_tasks AS task
LEFT JOIN LATERAL (
    SELECT item.id,
           EXISTS (
               SELECT 1
               FROM experiment_tasks AS occupied_task
               WHERE occupied_task.project_id = task.project_id
                 AND occupied_task.evaluation_run_id = task.evaluation_run_id
                 AND occupied_task.evaluation_run_item_id = item.id
                 AND occupied_task.id <> task.id
           ) AS occupied
    FROM evaluation_run_items AS item
    WHERE item.project_id = task.project_id
      AND item.run_id = task.evaluation_run_id
      AND item.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
    ORDER BY item.id
    LIMIT 1
) AS candidate ON task.evaluation_run_id IS NOT NULL
WHERE (task.evaluation_run_id IS NULL) <> (task.evaluation_run_item_id IS NULL)
ON CONFLICT (task_id) DO UPDATE
SET project_id = EXCLUDED.project_id,
    evaluation_run_id = EXCLUDED.evaluation_run_id,
    evaluation_run_item_id = EXCLUDED.evaluation_run_item_id,
    remediated_evaluation_run_item_id = EXCLUDED.remediated_evaluation_run_item_id,
    reason = EXCLUDED.reason;

-- A completed result is proven to belong to its task only through its immutable
-- experiment and Dataset-version item identity. Repair that relationship in the
-- same migration as the task, never by a broad Run-level rewrite.
UPDATE experiment_results AS result
SET evaluation_run_id = task.evaluation_run_id,
    evaluation_run_item_id = quarantine.remediated_evaluation_run_item_id
FROM experiment_tasks AS task
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = task.id
WHERE quarantine.remediated_evaluation_run_item_id IS NOT NULL
  AND result.experiment_id = task.experiment_id
  AND result.project_id = task.project_id
  AND result.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
  AND (
      result.evaluation_run_id IS NOT DISTINCT FROM task.evaluation_run_id
      OR result.evaluation_run_item_id IS NOT DISTINCT FROM quarantine.evaluation_run_item_id
  );

UPDATE experiment_tasks AS task
SET evaluation_run_item_id = quarantine.remediated_evaluation_run_item_id
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.remediated_evaluation_run_item_id IS NOT NULL
  AND (task.evaluation_run_id IS NULL) <> (task.evaluation_run_item_id IS NULL);

-- No candidate, or an occupied candidate, is intentionally not guessed. Keep
-- the completed result row, but remove its unusable Run linkage with the task.
UPDATE experiment_results AS result
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_tasks AS task
JOIN experiment_task_run_item_mismatch_quarantine AS quarantine
  ON quarantine.task_id = task.id
WHERE quarantine.remediated_evaluation_run_item_id IS NULL
  AND result.experiment_id = task.experiment_id
  AND result.project_id = task.project_id
  AND result.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
  AND (
      result.evaluation_run_id IS NOT DISTINCT FROM quarantine.evaluation_run_id
      OR result.evaluation_run_item_id IS NOT DISTINCT FROM quarantine.evaluation_run_item_id
  );

UPDATE experiment_tasks AS task
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
FROM experiment_task_run_item_mismatch_quarantine AS quarantine
WHERE quarantine.task_id = task.id
  AND quarantine.remediated_evaluation_run_item_id IS NULL
  AND (task.evaluation_run_id IS NULL) <> (task.evaluation_run_item_id IS NULL);

-- 0091 could already have repaired a task before this migration runs. Rejoin
-- its proven completed result to that repaired item instead of dropping the
-- result from evidence, metric, comparison, and gate queries.
UPDATE experiment_results AS result
SET evaluation_run_id = task.evaluation_run_id,
    evaluation_run_item_id = task.evaluation_run_item_id
FROM experiment_tasks AS task
WHERE task.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_item_id IS NOT NULL
  AND result.experiment_id = task.experiment_id
  AND result.project_id = task.project_id
  AND result.dataset_version_item_id IS NOT DISTINCT FROM task.dataset_version_item_id
  AND result.evaluation_run_id = task.evaluation_run_id
  AND result.evaluation_run_item_id IS DISTINCT FROM task.evaluation_run_item_id;

-- Result pairs are consumed together by lifecycle, evidence, comparison, and
-- gate queries. Repair a remaining half pair only from its matching task.
UPDATE experiment_results AS result
SET evaluation_run_id = task.evaluation_run_id,
    evaluation_run_item_id = task.evaluation_run_item_id
FROM experiment_tasks AS task
WHERE (result.evaluation_run_id IS NULL) <> (result.evaluation_run_item_id IS NULL)
  AND task.experiment_id = result.experiment_id
  AND task.project_id = result.project_id
  AND task.dataset_version_item_id IS NOT DISTINCT FROM result.dataset_version_item_id
  AND task.evaluation_run_id IS NOT NULL
  AND task.evaluation_run_item_id IS NOT NULL
  AND (
      result.evaluation_run_id IS NULL
      OR result.evaluation_run_id = task.evaluation_run_id
  );

UPDATE experiment_results
SET evaluation_run_id = NULL,
    evaluation_run_item_id = NULL
WHERE (evaluation_run_id IS NULL) <> (evaluation_run_item_id IS NULL);

ALTER TABLE experiment_tasks
    DROP CONSTRAINT IF EXISTS experiment_tasks_evaluation_run_item_pair_check;
ALTER TABLE experiment_tasks
    ADD CONSTRAINT experiment_tasks_evaluation_run_item_pair_check
    CHECK ((evaluation_run_id IS NULL) = (evaluation_run_item_id IS NULL));

ALTER TABLE experiment_results
    DROP CONSTRAINT IF EXISTS experiment_results_evaluation_run_item_pair_check;
ALTER TABLE experiment_results
    ADD CONSTRAINT experiment_results_evaluation_run_item_pair_check
    CHECK ((evaluation_run_id IS NULL) = (evaluation_run_item_id IS NULL));
