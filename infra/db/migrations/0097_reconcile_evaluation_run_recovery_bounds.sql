-- A 0095 upgrade could make every historical active Run immediately resumable
-- and set its provider charge ledger to zero. Recovery must re-admit each Run
-- against the live policy instead of trusting that transient upgrade state.
UPDATE evaluation_runs AS run
SET provider_call_count = GREATEST(run.provider_call_count, dispatch.provider_call_count)
FROM (
    SELECT experiment.evaluation_run_id AS run_id,
           count(DISTINCT effect.id)::integer AS provider_call_count
    FROM experiments AS experiment
    JOIN experiment_tasks AS task
      ON task.experiment_id = experiment.id
     AND task.project_id = experiment.project_id
    JOIN execution_effects AS effect
      ON effect.work_kind = 'experiment_task'
     AND effect.work_id = task.id
     AND effect.project_id = task.project_id
     AND effect.effect = 'provider_dispatch'
    WHERE experiment.evaluation_run_id IS NOT NULL
    GROUP BY experiment.evaluation_run_id
) AS dispatch
WHERE run.id = dispatch.run_id
  AND run.provider_call_count < dispatch.provider_call_count;

UPDATE evaluation_run_capacity_admissions AS capacity
SET status = 'released',
    released_at = COALESCE(released_at, now()),
    release_reason = COALESCE(release_reason, 'recovery_reconciliation')
FROM evaluation_runs AS run
WHERE capacity.run_id = run.id
  AND capacity.project_id = run.project_id
  AND capacity.status = 'active'
  AND run.status IN ('pending', 'running');
