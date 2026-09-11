-- Preserve an explicit terminal reason when compatibility Experiment status
-- synchronization runs after the Evaluation Run has already been terminalized.
CREATE OR REPLACE FUNCTION sync_evaluation_run_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.evaluation_run_id IS NOT NULL
       AND NEW.status IN ('pending', 'running', 'completed', 'failed', 'cancelled') THEN
        UPDATE evaluation_runs
        SET status = NEW.status,
            terminal_reason = CASE
                WHEN NEW.status IN ('pending', 'running') THEN NULL
                WHEN evaluation_runs.terminal_reason IS NOT NULL
                    THEN evaluation_runs.terminal_reason
                WHEN NEW.status = 'cancelled' THEN 'cancelled'
                WHEN NEW.status = 'completed' THEN 'all_items_completed'
                WHEN EXISTS (
                    SELECT 1
                    FROM experiment_tasks task
                    WHERE task.experiment_id = NEW.id
                      AND task.project_id = NEW.project_id
                      AND task.status = 'failed'
                ) THEN 'task_failed'
                ELSE 'execution_failed'
            END,
            updated_at = now()
        WHERE id = NEW.evaluation_run_id
          AND project_id = NEW.project_id;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS evaluation_run_status_sync ON experiments;
CREATE TRIGGER evaluation_run_status_sync
AFTER INSERT OR UPDATE OF status ON experiments
FOR EACH ROW EXECUTE FUNCTION sync_evaluation_run_status();
